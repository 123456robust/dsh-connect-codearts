# dsh-connect-codearts

Connect **Huawei Cloud CodeArts / ModelArts Studio (MaaS)** models to [DSH](https://github.com/deepseek-ai/dsh).

The plugin serves a loopback OpenAI-compatible endpoint, signs every request with Huawei Cloud `SDK-HMAC-SHA256` and forwards it upstream — so you no longer need a separate Python signing proxy, nor a hand-written `apiKeyEnv` row in `cordis.patch.yml`.

> Structure follows [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) and [@dmh2002/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder) (both MIT). Not affiliated with Huawei Cloud.

---

## The problem it solves

Huawei Cloud's `snap-access` endpoint requires a set of **dynamic signing headers** on every request (`x-sdk-date`, `x-ot-session-id`, `Authorization: SDK-HMAC-SHA256 ...`). DSH's provider config only supports a static `apiKeyEnv` — a fixed string cannot express a per-request signature.

This plugin bridges that gap:

```
DSH  ──OpenAI protocol──▶  127.0.0.1:<random port>  ──signed──▶  snap-access.<region>.myhuaweicloud.com
                           (started by this plugin, guarded by a one-shot secret)
```

pi-ai keeps using the standard `openai-completions` protocol; the shim re-signs, forwards, and relays the SSE stream line by line. All secrets stay inside the host process — never written to disk, never sent to the browser.

## Features

- **Five verified-servable models**, filtered against real tenant availability
- **Multimodal**: `kimi-k2.6-vl` and `Qwen3-VL-235B` read images
- **Reasoning levels**: `low / medium / high / xhigh / max`; disabling thinking sends `thinking:{type:"disabled"}` (honoured by `glm-5.3` and `deepseek-v4.1-flash-1017`; `kimi-k3.1-pro` cannot be switched off — see design note §4.5)
- **In-band error translation**: the upstream reports failures as HTTP 200 + one error event; the plugin turns them into standard OpenAI error frames so the real reason reaches the UI
- **Automatic image downgrade**: images sent to text models are folded into a text note, so one bad message never poisons a session
- **Session keep-alive**: one pinned session id plus periodic heartbeat, working around the 3-concurrent-session cap
- **Settings card** and a **composer pill** showing credential state, region, upstream endpoint and the model list

## Bundled models

| Model | Context | Max output | Multimodal |
| --- | --- | --- | --- |
| `glm-5.3` | 1,048,576 | 65,536 | — |
| `kimi-k3.1-pro` | 262,144 | 32,768 | — |
| `deepseek-v4.1-flash-1017` | 262,144 | 32,768 | — |
| `kimi-k2.6-vl` | 262,144 | 32,768 | ✓ |
| `Qwen3-VL-235B` | 131,072 | 16,384 | ✓ |

The catalog is **empirical**: on the same tenant `deepseek-v3.2`, `qwen3-max`, `glm-4.6` and `kimi-k2` all return 404 (model not registered). Run `npm run probe` before editing it.

## Install

### 1. Provide Huawei Cloud credentials

Write to `~/.config/huaweicloud/credentials.json`:

```json
{
  "ak": "your AK",
  "sk": "your SK",
  "securityToken": "",
  "region": "cn-north-4"
}
```

Or use environment variables (they win over the file):

```bash
export CODEARTS_AK=...
export CODEARTS_SK=...
export CODEARTS_REGION=cn-north-4
```

Create AK/SK at [Huawei Cloud Console → My Credentials → Access Keys](https://console.huaweicloud.com/iam/).

### 2. Install the plugin

```bash
git clone <this-repo-url> dsh-connect-codearts
```

Then install the directory through DSH's plugin manager (`plugin_manager`, action `install_bundle`, `target` = absolute path), or drop it into the profile's `node_modules` and restart DSH.

After restarting, the model picker lists **CodeArts (HuaweiCloud MaaS)**.

## Configuration

Settings → Plugins → `dsh-connect-codearts`:

| Field | Default | Meaning |
| --- | --- | --- |
| `region` | `cn-north-4` | Huawei Cloud region; written into the upstream hostname. |
| `credentialsFile` | empty | Credential file path. Empty means the default location. |
| `models` | all five | Enabled model ids; changes apply immediately. |
| `heartbeat` | `true` | Whether to send session heartbeats. Failures never break chat. |

## Testing

```bash
npm test             # 17 checks, including live upstream calls
npm run test:offline # skip the networked checks
npm run probe glm-5.3 "hello"  # single upstream request
```

`npm test` starts a real shim and calls Huawei Cloud, so it needs local credentials.

## Design notes

### Signing

```
CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQuery \n
                   CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
StringToSign     = "SDK-HMAC-SHA256" \n x-sdk-date \n hex(sha256(CanonicalRequest))
Signature        = hex(HMAC-SHA256(key=SK, msg=StringToSign))
```

`CanonicalURI` must end with `/`, `CanonicalQuery` is empty, and `SignedHeaders` is the case-insensitively sorted, lowercased, semicolon-joined name list. See [`lib/signer.js`](lib/signer.js).

### Three compat flags you cannot skip

None of these are optional; each was forced by a measurement:

| Flag | What breaks without it |
| --- | --- |
| `maxTokensField: "max_tokens"` | The upstream ignores `max_completion_tokens` (`=8` still produced 622 tokens), leaving output completely uncapped |
| `supportsDeveloperRole: false` | The upstream rejects `role: "developer"` with `InferHub.001001044.400` |
| `thinkingFormat: "zai"` | Disabling thinking would send an illegal `reasoning_effort` string instead of `thinking:{type:"disabled"}` |

`thinkingLevelMap` also pins `minimal` to `null`: `glm-5.3` returns 400 for `reasoning_effort: "minimal"`, and pi-ai forwards an unmapped level **verbatim** as the effort string. Mapping it to `null` removes the level from the selectable list.

### Why images are folded

Sending an image to a text model yields **HTTP 200 plus one in-band error** (`InferHub.001001020.406 The request model is not multimodal`). The client only sees a truncated stream — and worse, the image stays in history, so every later request fails the same way. Folding it into a text note keeps the session usable.

### Why the session id is pinned

The upstream caps concurrent sessions per account (3). A fresh id per request exhausts the quota after three calls, so the whole process shares one pinned id kept alive by a heartbeat.

## Layout

```
lib/
  signer.js     # Node built-ins only: signing, credentials, SSE translation, heartbeat (unit-testable)
  shim.js       # Loopback OpenAI-compatible endpoint (depends only on signer.js)
  index.js      # DSH host half: PiAiAdapter, settings, status route
  client.js     # Browser half: settings card + composer pill
  index.d.ts    # Type declarations
scripts/
  selftest.mjs       # End-to-end self test (17 checks)
  probe-upstream.mjs # Single-request probe
locale/         # zh / en display metadata
icons/          # Icons
docs/DESIGN.md  # Design notes and measurement log
```

## Boundaries

- Proxies no vendor other than Huawei Cloud
- Does not touch DSH's own model-selection logic
- Never handles secrets in the browser
- Does not auto-retry — failures are reported honestly, and DSH's retry policy decides

## License

MIT — see [LICENSE](LICENSE).
