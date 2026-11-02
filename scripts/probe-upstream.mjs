// 真机验证：直接用插件自带的签名器打上游，不经过 Python 代理。
// 用法：node scripts/probe-upstream.mjs [model] [prompt]
import { loadCredentials, streamUpstream, SseTranslator } from '../lib/signer.js'

const model = process.argv[2] ?? 'glm-5.3'
const prompt = process.argv[3] ?? 'Say OK'
const credentials = loadCredentials()
console.log(`creds: source=${credentials.source} region=${credentials.region} ak=${credentials.ak.slice(0, 4)}****`)

const body = JSON.stringify({ model, stream: true, max_tokens: 32, messages: [{ role: 'user', content: prompt }] })
const translator = new SseTranslator()
let out = ''
try {
  const res = await streamUpstream({ body, model, credentials, sessionId: `ses_${'a'.repeat(20)}`, onChunk: (c) => { out += translator.push(c).toString() } })
  out += translator.flush().toString()
  console.log('status:', res.status, '| failure:', translator.failureMessage() ?? 'none')
  console.log('bytes:', out.length, '| frames:', out.split('\n').filter((l) => l.startsWith('data:')).length)
  console.log(out.split('\n').filter((l) => l.startsWith('data:')).slice(0, 3).join('\n').slice(0, 500))
} catch (error) {
  console.log('ERR:', error.name, error.status ?? '', String(error.message).slice(0, 500))
}
