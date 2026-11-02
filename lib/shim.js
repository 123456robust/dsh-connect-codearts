/**
 * 回环 shim：把 OpenAI 兼容请求翻译成华为云 CodeArts 签名请求。
 *
 * 单独成文件（只 import Node 内置 + `./signer.js`），这样不依赖任何 DSH 包就能
 * 端到端测试——`scripts/selftest.mjs` 就是这么跑的。
 *
 * @module dsh-connect-codearts/shim
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_REGION,
  MAX_REQUEST_BYTES,
  SseTranslator,
  loadCredentials,
  safeEqual,
  streamUpstream,
  stripUnsupportedImages,
} from './signer.js'

/** 上游流式空闲超时：长思考模型可能几十秒不吐字。 */
export const STREAM_IDLE_TIMEOUT_MS = 600_000

/**
 * 构造一个 OpenAI 形状的错误响应体。
 * @param {string} message 错误说明。
 * @param {string} code 错误码。
 * @param {string} [type] 错误类型。
 * @returns {{error: {message: string, type: string, code: string, param: null}}}
 */
export function errorBody(message, code, type = 'invalid_request_error') {
  return { error: { message, type, code, param: null } }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status 状态码。
 * @param {unknown} body 响应体。
 */
export function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求对象。
 * @returns {Promise<Buffer>} 请求体字节。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 判断请求来源是否为本机回环。
 * @param {string|undefined} origin Origin 头。
 * @returns {boolean} 是否允许。
 */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * 起一个只服务本进程的回环 OpenAI 兼容端点。
 *
 * 安全边界：只监听 `127.0.0.1`、随机端口、每次启动生成一次性密钥；Host 头、
 * Origin、Authorization 三道校验都过才处理请求，所以同机其它进程无法借用。
 *
 * @param {object} options shim 选项。
 * @param {() => {region?: string, credentialsFile?: string}} options.readSettings 读取当前设置。
 * @param {() => Array<object>} options.readModels 读取当前启用的模型目录。
 * @returns {{ready: Promise<void>, baseUrl: string, secret: string, sessionId: string, close: () => void, stats: () => object}}
 */
export function createShim(options) {
  const secret = randomBytes(32).toString('base64url')
  const sessionId = `ses_${randomBytes(10).toString('hex')}`
  let baseUrl = ''
  /** 最近一次请求的诊断信息，只给状态接口看。 */
  const stats = { lastRequestAt: 0, lastModel: '', lastError: '', requests: 0, imageStripped: 0 }

  const server = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '')
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host)) {
        json(res, 403, errorBody('host not allowed', 'host_not_allowed'))
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        json(res, 403, errorBody('origin not allowed', 'origin_not_allowed'))
        return
      }
      const auth = String(req.headers.authorization ?? '')
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!safeEqual(provided, secret)) {
        json(res, 401, errorBody('invalid api key', 'invalid_api_key', 'authentication_error'))
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = options.readModels()
        json(res, 200, {
          object: 'list',
          data: models.map((model) => ({
            id: model.id,
            object: 'model',
            owned_by: 'huaweicloud-codearts',
            name: model.name,
            context_window: model.contextWindow,
            max_output_tokens: model.maxTokens,
            input_modalities: model.multimodal ? ['text', 'image'] : ['text'],
          })),
        })
        return
      }

      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        json(res, 404, errorBody(`no route for ${req.method} ${url.pathname}`, 'not_found'))
        return
      }

      const raw = await readBody(req)
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        json(res, 400, errorBody('request body is not valid JSON', 'invalid_json'))
        return
      }

      const modelId = typeof payload?.model === 'string' ? payload.model : ''
      const entry = options.readModels().find((model) => model.id === modelId)
      if (entry === undefined) {
        json(res, 404, errorBody(`model "${modelId}" is not enabled in this plugin`, 'model_not_found'))
        return
      }
      if (payload.stream !== true) {
        json(res, 400, errorBody('only streaming is supported', 'stream_required'))
        return
      }

      // 图片块必须先处理：非多模态模型收到图片时上游回 200 + 带内错误，
      // 客户端只会看到一条被截断的流，而且这条图片会永久污染历史。
      const dropped = stripUnsupportedImages(payload, entry.multimodal)
      if (dropped > 0) stats.imageStripped += dropped
      const body = dropped > 0 ? Buffer.from(JSON.stringify(payload), 'utf8') : raw

      const settings = options.readSettings()
      let credentials
      try {
        credentials = loadCredentials({ file: settings.credentialsFile })
      } catch (error) {
        json(res, 401, errorBody(String(error?.message ?? error), error?.kind ?? 'CREDENTIALS_INVALID', 'authentication_error'))
        return
      }

      stats.requests += 1
      stats.lastRequestAt = Date.now()
      stats.lastModel = modelId

      const controller = new AbortController()
      res.on('close', () => controller.abort())

      const translator = new SseTranslator()
      let started = false
      const startStream = () => {
        if (started) return
        started = true
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.socket?.setNoDelay(true)
      }

      try {
        await streamUpstream({
          body,
          model: modelId,
          credentials,
          sessionId,
          clientVersion: DEFAULT_CLIENT_VERSION,
          signal: controller.signal,
          onChunk: (chunk) => {
            if (res.writableEnded || res.destroyed) return
            startStream()
            const out = translator.push(chunk)
            if (out.length > 0) res.write(out)
          },
        })
        startStream()
        const tail = translator.flush()
        if (tail.length > 0) res.write(tail)
        if (translator.failureMessage() !== undefined) stats.lastError = translator.failureMessage()
        res.end()
      } catch (error) {
        stats.lastError = String(error?.message ?? error).slice(0, 300)
        if (!started) {
          json(res, 502, errorBody(String(error?.message ?? error), 'upstream_error', 'upstream_error'))
          return
        }
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(errorBody(String(error?.message ?? error), 'upstream_error', 'upstream_error'))}\n\n`)
          res.end()
        }
      }
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        json(res, 500, errorBody(String(error?.message ?? error), 'internal_error'))
      }
    }
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('loopback shim did not bind a port'))
        return
      }
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })

  return {
    ready,
    secret,
    sessionId,
    get baseUrl() {
      return baseUrl
    },
    close: () => {
      server.close()
    },
    stats: () => ({ ...stats }),
  }
}

/**
 * 把目录条目翻成 pi-ai 的模型描述。
 *
 * `thinkingLevelMap` 里把 `minimal` 显式设成 `null`：上游 `glm-5.3` 收到
 * `reasoning_effort: "minimal"` 会回 400，而 pi-ai 对未映射的档位会**原样**
 * 把档位名当 effort 发出去。设成 `null` 后该档位直接从可选列表里消失。
 *
 * `compat` 三项都是被实测逼出来的：
 *   - `maxTokensField: "max_tokens"` —— 上游忽略 `max_completion_tokens`，
 *     不改会让输出完全不封顶。
 *   - `supportsDeveloperRole: false` —— 上游拒绝 `role: "developer"`。
 *   - `thinkingFormat: "zai"` —— 关闭思考时发 `thinking:{type:"disabled"}`，
 *     而不是发一个非法的 `reasoning_effort` 字符串。
 *
 * @param {object} info 目录条目。
 * @param {string} baseUrl shim 的 base url。
 * @param {string} providerId provider 路由 id。
 * @returns {object} pi-ai 模型描述。
 */
export function toPiModel(info, baseUrl, providerId) {
  const thinkingLevelMap = info.reasoning
    ? Object.fromEntries([['minimal', null], ...info.efforts.map((effort) => [effort, effort])])
    : undefined
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.multimodal ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    compat: {
      supportsReasoningEffort: thinkingLevelMap !== undefined,
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'zai',
    },
  }
}

/** 默认区域，方便调用方不写死。 */
export { DEFAULT_REGION }
