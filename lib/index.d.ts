/**
 * dsh-connect-codearts 的类型声明。
 *
 * 只声明 Host 半部分对外可见的部分；`client.js` 走浏览器模块表，不在类型层面暴露。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一个模型目录条目。 */
export interface CodeArtsModelInfo {
  /** 上游模型 id，也是 pi-ai 的 model id。 */
  id: string
  /** 界面显示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次最大输出。 */
  maxTokens: number
  /** 是否接受图片输入。 */
  multimodal: boolean
  /** 是否支持推理档位。 */
  reasoning: boolean
  /** 该模型接受的推理档位。 */
  efforts: string[]
}

/** 插件设置。 */
export interface CodeArtsConfig {
  /** 华为云区域。 */
  region: string
  /** 凭据文件路径，空串表示用默认位置。 */
  credentialsFile: string
  /** 启用的模型 id。 */
  models: string[]
  /** 是否发送会话心跳。 */
  heartbeat: boolean
}

/** provider 路由 id。 */
export declare const CODEARTS_PROVIDER: 'codearts'
/** provider 显示名。 */
export declare const CODEARTS_PROVIDER_DISPLAY_NAME: string
/** 兜底设置命名空间。 */
export declare const CODEARTS_SETTINGS_NS: string
/** 内置模型目录。 */
export declare const CODEARTS_MODELS: CodeArtsModelInfo[]
/** 插件名，同时是设置命名空间与路由前缀。 */
export declare const name: 'dsh-connect-codearts'
/** 依赖的宿主服务。 */
export declare const inject: string[]
/** 设置 schema。 */
export declare const Config: unknown

/** 凭据层错误。 */
export declare class CredentialError extends Error {
  kind: 'CREDENTIALS_MISSING' | 'CREDENTIALS_INVALID' | string
}

/**
 * 从 ctx 推导设置命名空间。
 * @param ctx Cordis 上下文。
 * @returns 设置命名空间。
 */
export declare function settingsNamespaceOf(ctx: Context): string

/**
 * 把目录条目翻成 pi-ai 模型描述。
 * @param info 目录条目。
 * @param baseUrl shim 的 base url。
 * @param providerId provider 路由 id。
 * @returns pi-ai 模型描述。
 */
export declare function toPiModel(info: CodeArtsModelInfo, baseUrl: string, providerId: string): object

/**
 * 组装 PiAiAdapter。
 * @param options shim 与目录。
 * @returns adapter 与失效函数。
 */
export declare function createCodeArtsAdapter(options: {
  shim: { baseUrl: string; secret: string }
  catalog: () => CodeArtsModelInfo[]
}): { adapter: unknown; invalidate: () => void }

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 设置。
 */
export declare function apply(ctx: Context, config: CodeArtsConfig): void

declare const _default: {
  name: typeof name
  inject: typeof inject
  Config: typeof Config
  apply: typeof apply
  settingsNamespaceOf: typeof settingsNamespaceOf
  toPiModel: typeof toPiModel
}
export default _default
