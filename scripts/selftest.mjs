/**
 * 端到端自测：起一个真的 shim，用 OpenAI 兼容请求打进去，转发到真实上游。
 *
 * 只依赖 Node 内置模块与插件自己的 `lib/signer.js` / `lib/shim.js`，**不加载
 * DSH**，所以在任何装了 Node 22 的机器上都能跑：
 *
 *   node scripts/selftest.mjs            # 跑全部用例
 *   node scripts/selftest.mjs --offline  # 跳过需要联网的用例
 *
 * 需要本机已有华为云凭据（`~/.config/huaweicloud/credentials.json` 或
 * `CODEARTS_AK`/`CODEARTS_SK`）。
 */

import { buildThinkingLevelMap, createShim } from '../lib/shim.js'
import { loadCredentials, signHeaders, inbandErrorOf, stripUnsupportedImages, maskAk } from '../lib/signer.js'
import { attachAuxService } from '../lib/ctx-bridge.js'

const offline = process.argv.includes('--offline')
let passed = 0
let failed = 0

/**
 * 跑一个用例并汇报。
 * @param {string} label 用例名。
 * @param {() => Promise<void>|void} fn 用例体，抛异常即失败。
 */
async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${String(error?.message ?? error)}`)
  }
}

/**
 * 断言。
 * @param {unknown} condition 条件。
 * @param {string} message 失败说明。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 内置测试目录，形状与 `lib/index.js` 的 `CODEARTS_MODELS` 一致。 */
const CATALOG = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 65_536, multimodal: false, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k2.6-vl', name: 'Kimi K2.6 VL', contextWindow: 262_144, maxTokens: 32_768, multimodal: true, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 262_144, maxTokens: 32_768, multimodal: false, reasoning: true, canDisableThinking: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 262_144, maxTokens: 32_768, multimodal: false, reasoning: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
]

console.log('\n== 纯函数 ==')

await test('签名头包含 Authorization 且 SignedHeaders 小写分号拼接', () => {
  const headers = signHeaders({
    body: '{"a":1}',
    model: 'glm-5.3',
    ak: 'AKTEST',
    sk: 'SKTEST',
    sessionId: 'ses_test',
    clientIp: '10.0.0.1',
    now: new Date('2026-01-02T03:04:05Z'),
  })
  assert(/^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/u.test(headers.Authorization), `Authorization 形状不对：${headers.Authorization}`)
  assert(headers['x-sdk-date'] === '20260102T030405Z', `x-sdk-date 不对：${headers['x-sdk-date']}`)
  assert(headers.host === 'snap-access.cn-north-4.myhuaweicloud.com', `host 不对：${headers.host}`)
  assert(headers['model-id'] === 'glm-5.3', 'model-id 必须进签名')
  assert(headers['x-security-token'] === '', '普通 AK/SK 的 security token 应为空串')
})

await test('相同输入两次签名得到相同 Signature（随机源可注入）', () => {
  let seed = 0
  const randomHex = (bytes) => `${seed++}`.padStart(bytes * 2, '0').slice(0, bytes * 2)
  const base = { body: '{"a":1}', model: 'glm-5.3', ak: 'AK', sk: 'SK', sessionId: 'ses_x', clientIp: '10.0.0.1', now: new Date('2026-01-02T03:04:05Z'), randomHex }
  seed = 0
  const one = signHeaders(base).Authorization.match(/Signature=([0-9a-f]+)/u)[1]
  seed = 0
  const two = signHeaders(base).Authorization.match(/Signature=([0-9a-f]+)/u)[1]
  assert(one === two, '签名不稳定')

  seed = 0
  const three = signHeaders({ ...base, body: '{"a":2}' }).Authorization.match(/Signature=([0-9a-f]+)/u)[1]
  assert(one !== three, '请求体变了签名却不变')
})

await test('缺少 AK/SK 抛 CredentialError', () => {
  let kind
  try {
    signHeaders({ body: '{}', model: 'm', ak: '', sk: 'SK' })
  } catch (error) {
    kind = error.kind
  }
  assert(kind === 'CREDENTIALS_INVALID', `期望 CREDENTIALS_INVALID，实际 ${kind}`)
})

await test('maskAk 只暴露首尾四位', () => {
  assert(maskAk('ABCDZZZZ111122223333WXYZ') === 'ABCD****WXYZ', maskAk('ABCDZZZZ111122223333WXYZ'))
})

await test('stripUnsupportedImages 只动非多模态模型', () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] }
  const dropped = stripUnsupportedImages(payload, false)
  assert(dropped === 1, `期望折叠 1 个图片块，实际 ${dropped}`)
  assert(payload.messages[0].content[1].type === 'text', '图片块应被替换成文字块')

  const multimodal = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] }
  assert(stripUnsupportedImages(multimodal, true) === 0, '多模态模型不该被折叠')
  assert(multimodal.messages[0].content[0].type === 'image_url', '多模态模型的图片块必须原样保留')
})

await test('inbandErrorOf 认三种带内错误形状', () => {
  assert(inbandErrorOf({ error_code: 'E1', error_msg: 'boom' })?.code === 'E1', '形状一')
  assert(inbandErrorOf({ error: { code: 'E2', message: 'boom2' } })?.code === 'E2', '形状二')
  assert(inbandErrorOf({ code: 'E3', message: 'boom3' })?.code === 'E3', '形状三')
  assert(inbandErrorOf({ choices: [{ delta: { content: 'ok' } }] }) === undefined, '正常帧不该被判成错误')
})

console.log('\n== 思考档位 ==')

await test('glm-5.3 不提供 minimal，但提供 low…max 与关闭思考', () => {
  const map = buildThinkingLevelMap(CATALOG[0])
  assert(map.minimal === null, `minimal 必须为 null，实际 ${String(map.minimal)}`)
  assert(map.low === 'low' && map.max === 'max', 'low/max 应映射到同名 effort')
  assert(map.off === undefined, 'off 缺省才表示支持关闭思考（zai 会发 disabled）')
})

await test('deepseek-v4.1-flash-1017 提供 minimal（实测上游接受）', () => {
  const map = buildThinkingLevelMap(CATALOG[3])
  assert(map.minimal === 'minimal', `minimal 应映射成 "minimal"，实际 ${String(map.minimal)}`)
})

await test('关不掉思考的模型把 off 映射成 null，选择器里不出现假开关', () => {
  const map = buildThinkingLevelMap(CATALOG[2])
  assert(map.off === null, `off 必须为 null，实际 ${String(map.off)}`)
  assert(map.minimal === null, 'kimi-k3.1-pro 同样不接受 minimal')
})

console.log('\n== ctx 附属服务 ==')

/**
 * 造一个最小的 cordis 语义替身：`set` 对未 provide 的名字抛错，与 cordis 4 一致。
 * @param {Iterable<string>} [provided] 已经 provide 过的服务名。
 */
function fakeCtx(provided = []) {
  const store = new Map([...provided].map((key) => [key, undefined]))
  return {
    store,
    provide(serviceName, value) {
      if (store.has(serviceName)) throw new Error(`service "${serviceName}" already provided`)
      store.set(serviceName, value)
    },
    set(serviceName, value) {
      if (!store.has(serviceName)) throw new Error(`cannot set property "${serviceName}" without provide`)
      store.set(serviceName, value)
    },
    get(serviceName) {
      return store.get(serviceName)
    },
  }
}

await test('attachAuxService 对未 provide 的服务落到 provide，不再抛错', () => {
  const ctx = fakeCtx()
  const warnings = []
  const branch = attachAuxService(ctx, 'codeartsSettings', { a: 1 }, (error) => warnings.push(String(error?.message ?? error)))
  assert(branch === 'provided', `期望 provided，实际 ${branch}`)
  assert(warnings.length === 0, `不该有警告：${warnings.join(' / ')}`)
  assert(ctx.get('codeartsSettings')?.a === 1, '服务没挂上')
})

await test('attachAuxService 对已存在的服务走 set 覆写', () => {
  const ctx = fakeCtx(['codeartsSettings'])
  const branch = attachAuxService(ctx, 'codeartsSettings', { a: 2 }, () => {})
  assert(branch === 'set', `期望 set，实际 ${branch}`)
  assert(ctx.get('codeartsSettings')?.a === 2, '没覆写成新值')
})

await test('set 与 provide 都失败时降级成 warn，绝不向外传播', () => {
  const ctx = fakeCtx(['codeartsSettings'])
  ctx.set = () => {
    throw new Error('cannot set property "codeartsSettings" in multiple fibers')
  }
  const warnings = []
  const branch = attachAuxService(ctx, 'codeartsSettings', {}, (error) => warnings.push(String(error?.message ?? error)))
  assert(branch === 'failed', `期望 failed，实际 ${branch}`)
  assert(warnings.length === 1, `应该恰好一条 warn，实际 ${warnings.length}`)
})

await test('裸 ctx.set 一个未 provide 的名字确实会抛（复现原始缺陷）', () => {
  const ctx = fakeCtx()
  let thrown = false
  try {
    ctx.set('codeartsSettings', {})
  } catch {
    thrown = true
  }
  assert(thrown, 'cordis 4 语义下应当抛错；若这里不抛，说明替身与真实 cordis 不符')
})

console.log('\n== 回环 shim ==')

const shim = createShim({ readSettings: () => ({ region: 'cn-north-4', credentialsFile: '' }), readModels: () => CATALOG })
await shim.ready

/**
 * 打一发 shim。
 * @param {string} path 路径。
 * @param {object} [options] 选项。
 * @returns {Promise<Response>} fetch 响应。
 */
function call(path, options = {}) {
  return fetch(`${shim.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${options.secret ?? shim.secret}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: options.body }),
  })
}

await test('GET /healthz 通', async () => {
  const res = await call('/healthz')
  assert(res.status === 200, `状态码 ${res.status}`)
  assert((await res.json()).ok === true, 'body 不对')
})

await test('GET /v1/models 列出目录', async () => {
  const res = await call('/v1/models')
  const body = await res.json()
  assert(res.status === 200, `状态码 ${res.status}`)
  assert(body.data.length === CATALOG.length, `期望 ${CATALOG.length} 个模型，实际 ${body.data.length}`)
  assert(body.data.find((m) => m.id === 'kimi-k2.6-vl').input_modalities.includes('image'), '多模态模型应声明 image 输入')
})

await test('错误密钥被拒（401）', async () => {
  const res = await call('/healthz', { secret: 'wrong-secret' })
  assert(res.status === 401, `状态码 ${res.status}`)
})

await test('未知模型被拒（404）', async () => {
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'no-such-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert(res.status === 404, `状态码 ${res.status}`)
})

await test('非流式请求被拒（400）', async () => {
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert(res.status === 400, `状态码 ${res.status}`)
})

shim.close()

if (offline) {
  console.log('\n--offline：跳过联网用例\n')
} else {
  console.log('\n== 真实上游 ==')
  const credentials = loadCredentials()
  console.log(`  凭据来源 ${credentials.source}，区域 ${credentials.region}，AK ${maskAk(credentials.ak)}`)

  const live = createShim({ readSettings: () => ({ region: credentials.region, credentialsFile: '' }), readModels: () => CATALOG })
  await live.ready

  /**
   * 收集一次流式回复。
   * @param {object} payload 请求体。
   * @returns {Promise<{status: number, text: string, content: string, reasoning: string, errors: Array<object>}>}
   */
  async function stream(payload) {
    const res = await fetch(`${live.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${live.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    let content = ''
    let reasoning = ''
    const errors = []
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payloadText = line.slice(5).trim()
      if (payloadText === '' || payloadText === '[DONE]') continue
      let frame
      try {
        frame = JSON.parse(payloadText)
      } catch {
        continue
      }
      if (frame.error !== undefined) {
        errors.push(frame.error)
        continue
      }
      const delta = frame.choices?.[0]?.delta
      if (delta?.content !== undefined) content += delta.content
      if (delta?.reasoning_content !== undefined) reasoning += delta.reasoning_content
    }
    return { status: res.status, text, content, reasoning, errors }
  }

  await test('glm-5.3 能流式回答', async () => {
    const out = await stream({ model: 'glm-5.3', stream: true, max_tokens: 64, messages: [{ role: 'user', content: '只回一个词：好' }] })
    assert(out.status === 200, `状态码 ${out.status}：${out.text.slice(0, 200)}`)
    assert(out.errors.length === 0, `带内错误：${JSON.stringify(out.errors[0])}`)
    assert(out.content.length > 0 || out.reasoning.length > 0, '没有任何内容返回')
  })

  await test('max_tokens 被严格尊重', async () => {
    const out = await stream({ model: 'glm-5.3', stream: true, max_tokens: 4, messages: [{ role: 'user', content: '从 1 数到 100' }] })
    const completion = out.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((s) => s !== '[DONE]').map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean).find((f) => f.usage)?.usage?.completion_tokens
    assert(completion !== undefined && completion <= 4, `completion_tokens=${completion}，max_tokens 没被尊重`)
  })

  await test('system role 被接受', async () => {
    const out = await stream({ model: 'glm-5.3', stream: true, max_tokens: 32, messages: [{ role: 'system', content: '你很简短。' }, { role: 'user', content: '好' }] })
    assert(out.errors.length === 0, `带内错误：${JSON.stringify(out.errors[0])}`)
  })

  await test('多模态模型接受图片', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const out = await stream({
      model: 'kimi-k2.6-vl',
      stream: true,
      max_tokens: 48,
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？一个词。' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }],
    })
    assert(out.errors.length === 0, `带内错误：${JSON.stringify(out.errors[0])}`)
    assert((out.content + out.reasoning).length > 0, '没有任何内容返回')
  })

  await test('文字模型收到图片被折叠成文字而不是报错', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const out = await stream({
      model: 'glm-5.3',
      stream: true,
      max_tokens: 48,
      messages: [{ role: 'user', content: [{ type: 'text', text: '看到什么？' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }],
    })
    assert(out.errors.length === 0, `应被折叠成文字，却收到错误：${JSON.stringify(out.errors[0])}`)
  })

  await test('带内错误被翻成 OpenAI error 帧', async () => {
    // reasoning_effort: minimal 是 glm-5.3 明确不接受的档位，用它逼出一条带内错误。
    const out = await stream({ model: 'glm-5.3', stream: true, max_tokens: 16, reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'hi' }] })
    assert(out.errors.length > 0, '期望拿到一条翻译后的 error 帧，实际没有')
    assert(out.errors[0].type === 'upstream_error', `error.type 应为 upstream_error，实际 ${out.errors[0].type}`)
    assert(typeof out.errors[0].code === 'string' && out.errors[0].code.length > 0, 'error.code 不能为空')
  })

  live.close()
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
