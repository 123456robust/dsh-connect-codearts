/**
 * dsh-connect-codearts — Host 半部分。
 *
 * 把华为云 CodeArts / ModelArts Studio(MaaS) 上的模型接入 DSH。
 *
 * 做法：在本机回环地址上起一个 OpenAI 兼容端点（shim），pi-ai 用标准的
 * `openai-completions` 协议打进来；shim 重新做 SDK-HMAC-SHA256 签名后转发到
 * `https://snap-access.<region>.myhuaweicloud.com/api/v2/chat/completions`，
 * 并把上游的带内错误翻译成标准 OpenAI 错误帧。
 *
 * 为什么要中间这一跳：上游要求每个请求带一组动态签名头，而 DSH 的 provider
 * 配置只支持静态 `apiKeyEnv`。shim 用一次性随机密钥保护，只有本进程知道。
 *
 * @module dsh-connect-codearts
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_REGION,
  CredentialError,
  credentialsProbe,
  loadCredentials,
  maskAk,
  sendHeartbeat,
  upstreamHost,
} from './signer.js'
import { STREAM_IDLE_TIMEOUT_MS, createShim, json, toPiModel } from './shim.js'

/** Loader 条目 id，同时是设置命名空间与 `/plugins/<id>/…` 路由前缀。 */
export const name = 'dsh-connect-codearts'

/** 需要宿主提供的能力。`webServer` 走可选注入，缺了也能跑。 */
export const inject = ['llm', 'settings']

/** provider 路由 id。刻意不用 `codearts-maas`，避免和手写的 llm-pi-ai 行撞车。 */
export const CODEARTS_PROVIDER = 'codearts'

/** provider 在模型选择器里显示的名字。 */
export const CODEARTS_PROVIDER_DISPLAY_NAME = 'CodeArts (HuaweiCloud MaaS)'

/** 兜底的设置命名空间（正常情况下从 Loader 条目 id 推导）。 */
export const CODEARTS_SETTINGS_NS = name

/**
 * 内置模型目录。
 *
 * 只列**实测可服务**的模型：同一租户下 `deepseek-v3.2` / `qwen3-max` /
 * `glm-4.6` / `kimi-k2` 都会返回 404（模型未注册）。改这里之前先用
 * `scripts/probe-upstream.mjs` 打一发确认。
 *
 * `multimodal: false` 的模型收到图片块会被折叠成文字——上游对这种情况回的是
 * HTTP 200 + 一条带内错误，不折叠会让整个会话卡死在历史里。
 */
export const CODEARTS_MODELS = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    multimodal: false,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'kimi-k3.1-pro',
    name: 'Kimi K3.1 Pro',
    contextWindow: 262_144,
    maxTokens: 32_768,
    multimodal: false,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 262_144,
    maxTokens: 32_768,
    multimodal: false,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'kimi-k2.6-vl',
    name: 'Kimi K2.6 VL',
    contextWindow: 262_144,
    maxTokens: 32_768,
    multimodal: true,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'Qwen3-VL-235B',
    name: 'Qwen3-VL 235B',
    contextWindow: 131_072,
    maxTokens: 16_384,
    multimodal: true,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
]

/** 全部模型的 id，作为设置的默认值。 */
const DEFAULT_ENABLED_MODELS = CODEARTS_MODELS.map((model) => model.id)

/** pi-ai 的附件预算，与参考实现保持一致。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/**
 * 让一个 schema 字段在运行时可变（改设置不必重启插件）。
 * @param {object} schema schemastery schema。
 * @returns {object} 可能带 volatile 的 schema。
 */
function asVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema
}

/**
 * 读取 volatile 字段的当前值。
 * @param {unknown} value 可能是 volatile 包装的值。
 * @returns {unknown} 解包后的值。
 */
function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') return value.get()
  return value
}

/** 插件设置。字段名保持英文，描述走中文。 */
export const Config = z.object({
  region: z
    .string()
    .default(DEFAULT_REGION)
    .description('华为云区域，例如 cn-north-4。区域会写进上游主机名。'),
  credentialsFile: z
    .string()
    .default('')
    .description('华为云凭据文件路径。留空则用 ~/.config/huaweicloud/credentials.json；环境变量 CODEARTS_AK / CODEARTS_SK 优先级更高。'),
  models: asVolatile(
    z
      .array(z.string())
      .default(DEFAULT_ENABLED_MODELS)
      .description('启用的模型 id。改这里可以在不重启的情况下增删模型。'),
  ),
  heartbeat: z
    .boolean()
    .default(true)
    .description('是否周期性发送会话心跳。心跳失败不影响聊天，只是保活固定会话槽位。'),
})

/**
 * 从 ctx 推导设置命名空间。
 * @param {object} ctx Cordis 上下文。
 * @returns {string} 设置命名空间。
 */
export function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : CODEARTS_SETTINGS_NS
}

/**
 * 组装 PiAiAdapter。
 * @param {object} options 选项。
 * @param {object} options.shim 回环 shim。
 * @param {() => Array<object>} options.catalog 当前模型目录。
 * @returns {{adapter: PiAiAdapter, invalidate: () => void}}
 */
export function createCodeArtsAdapter(options) {
  const { shim, catalog } = options
  const providerId = CODEARTS_PROVIDER
  const providerName = CODEARTS_PROVIDER_DISPLAY_NAME
  const api = openAICompletionsApi()

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl}/v1`
    return catalog().map((info) => toPiModel(info, baseUrl, providerId))
  }

  const provider = {
    ...createProvider({
      id: providerId,
      name: providerName,
      auth: {
        apiKey: {
          name: 'CodeArts loopback token',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return {
              auth: apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
              source: 'CodeArts loopback token',
            }
          },
        },
      },
      models: buildModels(),
      api,
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `${name} retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[providerId, profile]])

  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      // 上游凭据由 shim 自己读，pi-ai 这一层不需要任何账号。
      auth: {
        credentials: {
          async read() {},
          async list() {
            return []
          },
          async modify() {},
        },
        authContext: {},
      },
      resolveApiKey: async () => shim.secret,
    }),
    invalidate: () => {
      profiles = new Map([[providerId, profile]])
    },
  }
}

/**
 * 注册浏览器半部分要读的状态接口。
 * @param {object} ctx 带 webServer 的上下文。
 * @param {object} deps 依赖。
 */
function registerStatusRoute(ctx, deps) {
  const path = `/plugins/${name}/status`
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        const settings = deps.readSettings()
        const probe = credentialsProbe(settings.credentialsFile)
        let credentials = {
          ok: probe.ok,
          source: 'none',
          ak: '',
          region: settings.region,
          file: settings.credentialsFile,
          ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        }
        if (probe.ok) {
          try {
            const loaded = loadCredentials({ file: settings.credentialsFile })
            credentials = {
              ok: true,
              source: loaded.source,
              ak: maskAk(loaded.ak),
              region: loaded.region,
              file: loaded.file,
            }
          } catch (error) {
            credentials = {
              ok: false,
              source: 'error',
              ak: '',
              region: settings.region,
              file: settings.credentialsFile,
              reason: String(error?.message ?? error),
            }
          }
        }
        json(res, 200, {
          provider: CODEARTS_PROVIDER,
          displayName: CODEARTS_PROVIDER_DISPLAY_NAME,
          upstream: upstreamHost(settings.region),
          credentials,
          models: deps.readModels().map((model) => ({ id: model.id, name: model.name, multimodal: model.multimodal })),
          stats: deps.stats(),
        })
      },
    }),
  )
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 设置。
 */
export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx)
  let settingsService
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings
  })

  /** 当前设置快照。 */
  const readSettings = () => ({
    region: String(unwrapVolatile(config.region) ?? DEFAULT_REGION).trim() || DEFAULT_REGION,
    credentialsFile: String(unwrapVolatile(config.credentialsFile) ?? '').trim(),
    heartbeat: unwrapVolatile(config.heartbeat) !== false,
  })

  /** 当前启用的模型目录。 */
  const readModels = () => {
    const raw = unwrapVolatile(config.models)
    const enabled = Array.isArray(raw) ? raw : DEFAULT_ENABLED_MODELS
    if (enabled.length === 0) return CODEARTS_MODELS
    const wanted = new Set(enabled)
    const picked = CODEARTS_MODELS.filter((model) => wanted.has(model.id))
    return picked.length > 0 ? picked : CODEARTS_MODELS
  }

  const shim = createShim({ readSettings, readModels })
  let stopped = false
  let heartbeatTimer
  let adapter

  ctx.effect(() => () => {
    if (stopped) return
    stopped = true
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    shim.close()
  })

  shim.ready
    .then(() => {
      if (stopped) return
      adapter = createCodeArtsAdapter({ shim, catalog: readModels })
      const releaseAdapter = ctx.llm.registerAdapter([CODEARTS_PROVIDER], adapter.adapter)
      const releaseDirectory = ctx.llm.registerConfigurableProviders([
        {
          provider: CODEARTS_PROVIDER,
          displayName: CODEARTS_PROVIDER_DISPLAY_NAME,
          settingsNs,
          settingsPath: [],
          declared: false,
        },
      ])
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
      })

      ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
        if ((request?.provider ?? CODEARTS_PROVIDER) !== CODEARTS_PROVIDER) return []
        return readModels().map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          inputModalities: model.multimodal ? ['text', 'image'] : ['text'],
        }))
      })

      // 会话槽位保活：上游按账号限 3 个并发会话，固定 sessionId 之后只需要
      // 偶尔心跳一下；失败无所谓，下一次聊天会自然重新占位。
      if (readSettings().heartbeat) {
        heartbeatTimer = setInterval(() => {
          if (stopped) return
          try {
            const settings = readSettings()
            const credentials = loadCredentials({ file: settings.credentialsFile })
            const model = readModels()[0]?.id
            if (model === undefined) return
            void sendHeartbeat({
              credentials,
              sessionId: shim.sessionId,
              model,
              clientVersion: DEFAULT_CLIENT_VERSION,
            })
          } catch {
            /* 凭据还没配好，跳过这一拍 */
          }
        }, 30_000)
        heartbeatTimer.unref?.()
      }

      ctx.on('loader/volatile-update', () => {
        adapter?.invalidate()
      })
    })
    .catch((error) => {
      ctx.logger?.error?.(`${name}: loopback endpoint failed to start; provider not registered`, error)
    })

  ctx.inject(['webServer'], (ctxWithWeb) => {
    registerStatusRoute(ctxWithWeb, { readSettings, readModels, stats: () => shim.stats() })
  })

  /** 供设置卡片读写的字段。 */
  const settingsDeps = {
    describe: () => (settingsService === undefined ? [] : settingsService.describe()),
    set: async (field, value) => {
      if (field !== 'models' && field !== 'region' && field !== 'credentialsFile' && field !== 'heartbeat') {
        throw new Error(`unsupported settings field: ${String(field)}`)
      }
      const row = settingsService?.describe?.().find((entry) => String(entry.ns).includes(name))
      if (row === undefined) throw new Error('settings namespace not yet available')
      await settingsService.mutate(row.ns, [{ op: 'set', path: [field], value }], undefined)
      adapter?.invalidate()
    },
  }
  ctx.set?.('codeartsSettings', settingsDeps)
}

export { CredentialError }
export default { name, inject, Config, apply, settingsNamespaceOf, toPiModel }
