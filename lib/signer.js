/**
 * 华为云 CodeArts / MaaS 签名与上游转发核心。
 *
 * 这一层**不 import 任何 DSH 包**，只用 Node 内置模块，因此可以直接用
 * `node` 单测（见 `docs/DESIGN.md` 的验证记录），也便于被 CLI 复用。
 *
 * 为什么要自己签名：华为云 `snap-access` 端点要求每个请求带一组
 * SDK-HMAC-SHA256 签名头，而 DSH 的 pi-ai 路由只支持静态 `apiKeyEnv`。
 * 因此插件在本机起一个回环 shim，pi-ai 用 OpenAI 兼容协议打进来，这里重新
 * 签名后转发上游。
 *
 * 签名算法（从 CodeArts CLI 抓包逆出并实测通过）：
 *
 *   CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQuery \n
 *                      CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
 *   StringToSign     = "SDK-HMAC-SHA256" \n x-sdk-date \n hex(sha256(CanonicalRequest))
 *   Signature        = hex(HMAC-SHA256(key=SK, msg=StringToSign))
 *
 * 其中 CanonicalURI 必须以 "/" 结尾，CanonicalQuery 为空串。
 *
 * @module dsh-connect-codearts/signer
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'

/** 聊天补全上游路径。 */
export const UPSTREAM_PATH = '/api/v2/chat/completions'
/** 会话心跳路径（可选，best-effort）。 */
export const HEARTBEAT_PATH = '/snap-manager/v1/chat-session/heartbeat'
/** 默认区域。 */
export const DEFAULT_REGION = 'cn-north-4'
/** 冒充的 CodeArts CLI 版本，上游会读这个字段。 */
export const DEFAULT_CLIENT_VERSION = '26.9.26'
/** 请求体上限：长对话的完整 transcript 可能很大，1 MiB 不够。 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024

/**
 * 上游主机名。区域写进主机名，所以换区域就是换主机。
 * @param {string} region 华为云区域 id，例如 `cn-north-4`。
 * @returns {string} `snap-access.<region>.myhuaweicloud.com`
 */
export function upstreamHost(region = DEFAULT_REGION) {
  const clean = String(region ?? '').trim() || DEFAULT_REGION
  return `snap-access.${clean}.myhuaweicloud.com`
}

/**
 * 本机非回环 IPv4，用于签名的 `client-ip` 头。
 *
 * 用 `networkInterfaces()` 而不是 UDP connect 技巧：结果确定、同步、无副作用，
 * 也不会在离线机器上抛异常。
 * @returns {string} 一个 IPv4 地址，找不到时回退 `127.0.0.1`。
 */
export function localIp() {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family === 'IPv4' && info.internal === false) return info.address
      }
    }
  } catch {
    /* 取不到就用回环地址，签名的这个头不参与校验强度 */
  }
  return '127.0.0.1'
}

/** 当前凭据文件的默认位置。 */
export function defaultCredentialsFile() {
  return join(homedir(), '.config', 'huaweicloud', 'credentials.json')
}

/**
 * 掩码 AK，供界面展示；绝不输出 SK。
 * @param {string} ak 访问密钥 id。
 * @returns {string} 例如 `ABCD****WXYZ`。
 */
export function maskAk(ak) {
  const text = String(ak ?? '')
  if (text.length <= 8) return text === '' ? '' : '*'.repeat(text.length)
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/**
 * 读取华为云凭据。
 *
 * 支持三种来源，优先级从高到低：环境变量（`CODEARTS_AK`/`CODEARTS_SK`，兼容
 * `HUAWEICLOUD_AK`/`HUAWEICLOUD_SK`）、显式传入的文件、`~/.config/huaweicloud/credentials.json`。
 *
 * 返回的 `source` 只说「凭据从哪来」，不含任何密钥内容。
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options] 文件路径与环境快照。
 * @returns {{ak: string, sk: string, securityToken: string, region: string, source: string, file: string}}
 */
export function loadCredentials(options = {}) {
  const env = options.env ?? process.env
  const ak = (env.CODEARTS_AK ?? env.HUAWEICLOUD_AK ?? '').trim()
  const sk = (env.CODEARTS_SK ?? env.HUAWEICLOUD_SK ?? '').trim()
  if (ak !== '' && sk !== '') {
    return {
      ak,
      sk,
      securityToken: (env.CODEARTS_SECURITY_TOKEN ?? env.HUAWEICLOUD_SECURITY_TOKEN ?? '').trim(),
      region: (env.CODEARTS_REGION ?? env.HUAWEICLOUD_REGION ?? DEFAULT_REGION).trim() || DEFAULT_REGION,
      source: 'env',
      file: '',
    }
  }

  const file = (options.file ?? '').trim() || defaultCredentialsFile()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? '文件不存在' : String(error?.message ?? error)
    throw new CredentialError(`读不到华为云凭据：${file}（${reason}）`, 'CREDENTIALS_MISSING')
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new CredentialError(`华为云凭据不是合法 JSON：${file}`, 'CREDENTIALS_INVALID')
  }
  const fileAk = String(data?.ak ?? data?.accessKeyId ?? '').trim()
  const fileSk = String(data?.sk ?? data?.secretAccessKey ?? '').trim()
  if (fileAk === '' || fileSk === '') {
    throw new CredentialError(`华为云凭据缺少 ak / sk：${file}`, 'CREDENTIALS_INVALID')
  }
  return {
    ak: fileAk,
    sk: fileSk,
    securityToken: String(data?.securityToken ?? '').trim(),
    region: String(data?.region ?? DEFAULT_REGION).trim() || DEFAULT_REGION,
    source: 'file',
    file,
  }
}

/** 凭据层错误：带 `kind` 便于上层映射成 HTTP 状态。 */
export class CredentialError extends Error {
  constructor(message, kind) {
    super(message)
    this.name = 'CredentialError'
    this.kind = kind
  }
}

/** 上游返回的错误（含 HTTP 状态与原始体）。 */
export class UpstreamError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.body = body
  }
}

/** `%Y%m%dT%H%M%SZ`（UTC）。 */
function sdkDate(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** `%Y-%m-%dT%H:%M:%SZ`（UTC）。 */
function createdTime(now) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 构造一组已签名的请求头。
 *
 * 头集合与 CodeArts CLI 一致；其中 `user-session-id` / `x-ot-session-id` 是
 * **同一个固定会话 id**——上游按账号限制并发会话数（3 个），每个请求换新 id
 * 会在三次调用后耗尽配额。
 *
 * @param {object} input 签名输入。
 * @param {string|Buffer} input.body 请求体原文（必须与实际发送的字节完全一致）。
 * @param {string} input.model 模型 id，上游用它做路由，因此必须进签名。
 * @param {string} input.ak 访问密钥 id。
 * @param {string} input.sk 访问密钥。
 * @param {string} [input.securityToken] 临时凭据 token，普通 AK/SK 传空串。
 * @param {string} [input.host] 上游主机名。
 * @param {string} [input.path] 上游路径。
 * @param {string} [input.method] HTTP 方法。
 * @param {string} [input.sessionId] 固定会话 id。
 * @param {string} [input.clientVersion] 冒充的 CLI 版本。
 * @param {string} [input.clientIp] `client-ip` 头取值。
 * @param {Date} [input.now] 注入时间，便于单测。
 * @param {(bytes: number) => string} [input.randomHex] 注入随机源，便于复现同一次请求。
 * @returns {Record<string, string>} 含 `Authorization` 的完整请求头。
 */
export function signHeaders(input) {
  const {
    body,
    model,
    ak,
    sk,
    securityToken = '',
    host = upstreamHost(input.region),
    path = UPSTREAM_PATH,
    method = 'POST',
    sessionId,
    clientVersion = DEFAULT_CLIENT_VERSION,
    clientIp = localIp(),
    now = new Date(),
    randomHex = (bytes) => randomBytes(bytes).toString('hex'),
  } = input

  if (typeof ak !== 'string' || ak === '') throw new CredentialError('缺少 AK', 'CREDENTIALS_INVALID')
  if (typeof sk !== 'string' || sk === '') throw new CredentialError('缺少 SK', 'CREDENTIALS_INVALID')
  if (typeof model !== 'string' || model === '') throw new CredentialError('缺少模型 id', 'INVALID_REQUEST')

  const xSdkDate = sdkDate(now)
  const headers = {
    'client-ip': clientIp,
    'created-time': createdTime(now),
    host,
    'ide-name': 'CLI',
    'model-id': model,
    'model-name': model,
    'plugin-name': 'CLI',
    'plugin-version': clientVersion,
    'user-msg-id': `msg_${randomHex(10)}`,
    'user-session-id': sessionId,
    'x-language': 'zh-cn',
    'x-ot-client-type': 'CLI',
    'x-ot-client-version': clientVersion,
    'x-ot-function': 'agent-tui',
    'x-ot-parent-session-id': '',
    'x-ot-session-id': sessionId,
    'x-ot-span-id': randomHex(8),
    'x-ot-trace-id': randomHex(16),
    'x-sdk-date': xSdkDate,
    'x-security-token': securityToken,
    'x-snap-traceid': `${randomHex(16)}_${randomHex(8)}`,
  }

  const payloadHash = sha256Hex(body)
  // 华为云的 SignedHeaders 必须按名字**大小写不敏感**排序后小写拼接。
  const signedNames = Object.keys(headers).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
  const signedHeaderList = signedNames.map((name) => name.toLowerCase()).join(';')
  const canonicalHeaders = signedNames.map((name) => `${name.toLowerCase()}:${headers[name]}\n`).join('')

  const canonicalUri = path.endsWith('/') ? path : `${path}/`
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaderList, payloadHash].join('\n')
  const stringToSign = ['SDK-HMAC-SHA256', xSdkDate, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', sk).update(stringToSign).digest('hex')

  headers.Authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaderList}, Signature=${signature}`
  headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * 把不接受图片的模型请求里的图片块降级成文字说明。
 *
 * 上游对「非多模态模型 + 图片块」的回应是 **HTTP 200 + 单条带内错误事件**，
 * 客户端只能看到一条被截断的流；更糟的是这条图片会一直留在历史里，让之后每个
 * 请求都同样失败。折叠成一句文字说明，会话就还能继续。
 *
 * @param {object} payload 请求体（会被就地修改）。
 * @param {boolean} multimodal 该模型是否接受图片。
 * @returns {number} 被折叠的图片块数量。
 */
export function stripUnsupportedImages(payload, multimodal) {
  if (multimodal) return 0
  let dropped = 0
  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    let hit = 0
    const kept = content.map((part) => {
      const kind = part?.type
      if (kind === 'image_url' || kind === 'image' || kind === 'input_image') {
        hit += 1
        return { type: 'text', text: '[image omitted: this model does not accept image input]' }
      }
      return part
    })
    if (hit > 0) {
      message.content = kept
      dropped += hit
    }
  }
  return dropped
}

/**
 * 识别上游的「带内错误」帧。
 *
 * 上游用 HTTP 200 正常流里的一条事件报错，形状有三种，都见过：
 *   - `{"error_code":"InferHub...","error_msg":"..."}`
 *   - `{"error":{"message":"...","code":"..."}}`
 *   - `{"code":"...","message":"..."}`
 * @param {unknown} frame 解析后的 SSE 数据对象。
 * @returns {{code: string, message: string}|undefined} 归一化后的错误，或 undefined。
 */
export function inbandErrorOf(frame) {
  if (frame === null || typeof frame !== 'object') return undefined
  const code = typeof frame.error_code === 'string' ? frame.error_code : ''
  const message = typeof frame.error_msg === 'string' ? frame.error_msg : ''
  if (code !== '' || message !== '') {
    return { code: code || 'UPSTREAM_ERROR', message: message || code }
  }
  const nested = frame.error
  if (nested !== null && typeof nested === 'object') {
    const nestedCode = typeof nested.code === 'string' ? nested.code : ''
    const nestedMessage = typeof nested.message === 'string' ? nested.message : ''
    if (nestedCode !== '' || nestedMessage !== '') {
      return { code: nestedCode || 'UPSTREAM_ERROR', message: nestedMessage || nestedCode }
    }
    if (typeof nested === 'string' && nested !== '') return { code: 'UPSTREAM_ERROR', message: nested }
  }
  if (typeof frame.code === 'string' && typeof frame.message === 'string' && frame.choices === undefined) {
    return { code: frame.code, message: frame.message }
  }
  return undefined
}

/**
 * 发起一次已签名的上游请求，并把 SSE 逐行回灌给 `sink`。
 *
 * 逐行而不是整块：整块读会让客户端等完整次生成，触发它的 stream idle timeout。
 * @param {object} options 转发参数。
 * @param {string|Buffer} options.body 请求体。
 * @param {string} options.model 模型 id。
 * @param {object} options.credentials {@link loadCredentials} 的返回值。
 * @param {string} options.sessionId 固定会话 id。
 * @param {string} [options.clientVersion] 冒充的 CLI 版本。
 * @param {(chunk: Buffer) => void} options.onChunk 收到原始 SSE 字节。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{status: number, headers: Record<string, string>}>} 上游响应头信息。
 */
export function streamUpstream(options) {
  const { body, model, credentials, sessionId, clientVersion, onChunk, signal } = options
  const host = options.host ?? upstreamHost(credentials.region)
  const headers = signHeaders({
    body,
    model,
    ak: credentials.ak,
    sk: credentials.sk,
    securityToken: credentials.securityToken,
    host,
    sessionId,
    clientVersion,
  })

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        port: 443,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status !== 200) {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            reject(new UpstreamError(`上游 HTTP ${status}: ${text.slice(0, 500)}`, status, text))
          })
          res.on('error', reject)
          return
        }
        res.on('data', (chunk) => onChunk(chunk))
        res.on('end', () => resolve({ status, headers: res.headers }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    req.end(body)
  })
}

/**
 * 把上游 SSE 字节流切成 `data:` 载荷行，同时把带内错误翻成标准 OpenAI 错误帧。
 *
 * 这是 shim 的流式翻译器：上游的带内错误如果不翻，pi-ai 只能报
 * "Stream ended without finish_reason"，用户看不到真正原因（比如模型没开通、
 * 参数非法）。翻成 `{"error":{...}}` 后 OpenAI SDK 会抛 APIError，错误信息直达界面。
 */
export class SseTranslator {
  constructor() {
    /** @type {Buffer} 尚未凑成整行的尾巴 */
    this.pending = ''
    /** @type {string|undefined} 已经翻出错误帧后置位，后续字节一律丢弃 */
    this.failure = undefined
  }

  /**
   * 喂入一段原始字节，返回应当写给客户端的字节。
   * @param {Buffer|string} chunk 上游原始字节。
   * @returns {Buffer} 要写出去的字节（可能为空）。
   */
  push(chunk) {
    if (this.failure !== undefined) return Buffer.alloc(0)
    this.pending += chunk.toString('utf8')
    const out = []
    let index = this.pending.indexOf('\n')
    while (index >= 0) {
      const line = this.pending.slice(0, index)
      this.pending = this.pending.slice(index + 1)
      const translated = this.translateLine(line)
      if (translated !== undefined) {
        if (translated === null) return Buffer.from(out.join(''), 'utf8')
        out.push(translated)
      }
      index = this.pending.indexOf('\n')
    }
    return Buffer.from(out.join(''), 'utf8')
  }

  /**
   * 流结束时把残留的半行也处理掉。
   * @returns {Buffer} 尾字节。
   */
  flush() {
    if (this.failure !== undefined || this.pending === '') return Buffer.alloc(0)
    const rest = this.pending
    this.pending = ''
    const translated = this.translateLine(rest)
    return Buffer.from(translated === undefined || translated === null ? '' : translated, 'utf8')
  }

  /**
   * 处理一行。返回 `undefined` 表示原样透传，返回字符串表示替换，
   * 返回 `null` 表示「已失败，停止透传」。
   * @param {string} line 一行文本（不含换行）。
   * @returns {string|undefined|null}
   */
  translateLine(line) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return line === '' ? '\n' : `${line}\n`
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return `${line}\n`
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      return `${line}\n`
    }
    const failure = inbandErrorOf(frame)
    if (failure === undefined) return `${line}\n`
    this.failure = `${failure.code}: ${failure.message}`
    const errorFrame = {
      error: {
        message: failure.message,
        type: 'upstream_error',
        code: failure.code,
        param: null,
      },
    }
    return `data: ${JSON.stringify(errorFrame)}\n\n`
  }

  /** 流结束时若翻出过错误，返回该错误的可读文本。 */
  failureMessage() {
    return this.failure
  }
}

/**
 * 会话心跳：best-effort 保活固定会话槽位。
 *
 * 上游的 heartbeat 校验器会拒绝我们构造得出的 status 值
 * （`wsf.validator.session.status`），所以这**不是**必须成功的调用：会话固定
 * 本身已经解决了并发上限问题，过期的槽位会被下一次聊天请求自然重新占用。
 * @param {object} options 心跳参数。
 * @returns {Promise<boolean>} 只在拿到 2xx 时返回 true。
 */
export function sendHeartbeat(options) {
  const { credentials, sessionId, model, clientVersion } = options
  const host = options.host ?? upstreamHost(credentials.region)
  const body = JSON.stringify({ status: options.status ?? 'idle' })
  const headers = signHeaders({
    body,
    model,
    ak: credentials.ak,
    sk: credentials.sk,
    securityToken: credentials.securityToken,
    host,
    path: HEARTBEAT_PATH,
    method: 'PUT',
    sessionId,
    clientVersion,
  })
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host,
        port: 443,
        path: HEARTBEAT_PATH,
        method: 'PUT',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: 30_000,
      },
      (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end(body)
  })
}

/**
 * 常量时间比较，用于 shim 的 `Authorization` 校验。
 * @param {string} provided 请求带来的值。
 * @param {string} expected 期望值。
 * @returns {boolean}
 */
export function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8')
  const b = Buffer.from(String(expected ?? ''), 'utf8')
  if (a.length !== b.length || b.length === 0) return false
  return timingSafeEqual(a, b)
}

/**
 * 凭据文件是否可读（不抛异常，只回答「能用吗」）。
 * @param {string} [file] 凭据路径。
 * @returns {{ok: boolean, reason?: string, mtime?: number}}
 */
export function credentialsProbe(file) {
  const target = (file ?? '').trim() || defaultCredentialsFile()
  try {
    const stat = statSync(target)
    return { ok: true, mtime: stat.mtimeMs }
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}
