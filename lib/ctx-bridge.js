/**
 * ctx 附属服务注册 —— 与 DSH / cordis 打交道的边界，单独成文件。
 *
 * 为什么需要这一层：cordis 4 的 `Service.set()` 只允许**改写本 fiber 已经
 * `provide` 过的服务**，对一个从没 provide 过的名字调用 `ctx.set` 会直接抛
 * `cannot set property "<name>" without provide`。这种抛错发生在 `apply()`
 * 内部，会让整条 loader 条目激活失败 —— 插件看起来装上了，实际什么也没注册。
 *
 * 附属服务（比如给设置卡片用的桥接对象）不该有这种杀伤力：没有消费方时，
 * 它注册失败完全不影响 provider。所以统一走这里，失败降级成一条 warn。
 *
 * 本文件不 import 任何 DSH 包，因此 `scripts/selftest.mjs` 可以直接加载它做
 * 容器语义测试，不需要装 DSH。
 *
 * @module dsh-connect-codearts/ctx-bridge
 */

/**
 * 把一个附属服务挂到 ctx 上。
 *
 * 先试 `set`（改写本 fiber 已 provide 的服务，这是最常见的情形：热重载后服务还在），
 * 抛错再试 `provide`（首次注册）。两步都失败才认定注册失败并交给 `warn`。
 *
 * @param {object} ctx Cordis 上下文（只需 `provide` / `set`）。
 * @param {string} serviceName 服务名。
 * @param {unknown} value 服务实现。
 * @param {(error: unknown) => void} [warn] 失败回调；不给就静默。
 * @returns {"provided"|"set"|"failed"} 实际走的分支。
 */
export function attachAuxService(ctx, serviceName, value, warn) {
  if (typeof ctx?.set === 'function') {
    try {
      ctx.set(serviceName, value)
      return 'set'
    } catch {
      /* 还没 provide 过，落到下面 */
    }
  }
  if (typeof ctx?.provide === 'function') {
    try {
      ctx.provide(serviceName, value)
      return 'provided'
    } catch (error) {
      warn?.(error)
      return 'failed'
    }
  }
  return 'failed'
}
