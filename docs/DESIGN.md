# 设计说明

这份文档记录 `dsh-connect-codearts` 为什么长成这样，以及每个决定的实测依据。上游行为不是猜的 —— 下面每条都有对应的探针记录。

## 1. 问题：静态 apiKey 表达不了动态签名

华为云 `snap-access` 端点要求每个请求携带一组**逐请求变化**的签名头：

```
client-ip, created-time, host, ide-name, model-id, model-name, plugin-name,
plugin-version, user-msg-id, user-session-id, x-language, x-ot-client-type,
x-ot-client-version, x-ot-function, x-ot-parent-session-id, x-ot-session-id,
x-ot-span-id, x-ot-trace-id, x-sdk-date, x-security-token, x-snap-traceid
```

其中 `Authorization` 是对上述头 + 请求体的 HMAC 签名。DSH 的 provider 配置只有静态 `apiKeyEnv`，无法表达。

**先前的做法**是手工跑一个 Python 代理（`codearts-maas-proxy.py`）监听 8788，再在 `cordis.patch.yml` 里写 `baseURL: http://127.0.0.1:8788/v1`。能用，但要求用户：

1. 每次开机手动启动代理
2. 代理挂了 DSH 就静默失败
3. 两份配置（代理 + patch）必须同步

本插件把这件事收进插件内部：签名逻辑用 JS 重写，回环端点在插件生命周期内自动起停。

## 2. 架构

```
┌─────────┐   OpenAI 协议    ┌──────────────────┐   签名后 HTTPS   ┌──────────────────┐
│  DSH    │ ───────────────▶ │ lib/shim.js      │ ───────────────▶ │ snap-access      │
│ (pi-ai) │ ◀─────────────── │ 127.0.0.1:<rand> │ ◀─────────────── │ .<region>.hwcloud│
└─────────┘   SSE 逐行回灌    └──────────────────┘   SSE 逐行       └──────────────────┘
                                     │
                                     └── lib/signer.js：签名 / 凭据 / 错误翻译
```

分层理由：

- **`signer.js` 只用 Node 内置** —— 不 import 任何 DSH 包，所以能脱离 DSH 单测，也方便别人复用。
- **`shim.js` 只依赖 `signer.js`** —— 端到端测试不需要装 DSH。
- **`index.js` 才碰 DSH API** —— 把 DSH 依赖面压到最小，DSH 升级时改动范围可控。

## 3. 安全边界

回环端点虽然是「本机」，但本机可能有别的进程，所以设了三道闸：

1. **只监听 `127.0.0.1`**，端口由内核分配（`listen(0)`），不可预测
2. **一次性密钥**：每次启动 `randomBytes(32).toString('base64url')`，只存在于进程内存
3. **三道校验**：`Host` 头必须回环、`Origin` 必须是回环、`Authorization: Bearer <secret>` 必须用 `timingSafeEqual` 命中

所以同机其它进程即使扫到端口，没有那个一次性密钥也进不来。密钥不落盘、不进浏览器、不进日志。

## 4. 上游实测记录

以下全部在真实租户上验证过（`snap-access.cn-north-4.myhuaweicloud.com`）。

### 4.1 可服务模型

| 模型 | 结果 |
| --- | --- |
| `glm-5.3` | ✅ |
| `kimi-k3.1-pro` | ✅ |
| `deepseek-v4.1-flash-1017` | ✅ |
| `kimi-k2.6-vl` | ✅ 多模态 |
| `Qwen3-VL-235B` | ✅ 多模态 |
| `deepseek-v3.2` | ❌ `InferHub.ModelArts.81009.404 Invalid model.` |
| `qwen3-max` | ❌ `InferHub.002002009.404 The model is not registered` |
| `glm-4.6` | ❌ 同上 |
| `kimi-k2` | ❌ 同上 |

所以目录只列前五个。**不要凭模型名猜测可用性** —— 同一厂商的不同型号注册状态完全不同。

### 4.2 `max_tokens` vs `max_completion_tokens`

```
max_tokens=8             → completion_tokens=8      ✅ 严格尊重
max_completion_tokens=8  → completion_tokens=622    ❌ 完全忽略
```

pi-ai 的 `detectCompat` 对未知 baseURL 默认选 `max_completion_tokens`。不覆盖的后果是**输出完全不封顶**，长任务可能烧掉大量额度。所以必须 `compat.maxTokensField: "max_tokens"`。

### 4.3 `role: developer`

```
role:"system"     → ✅
role:"developer"  → ❌ InferHub.001001044.400 Message role cannot empty
```

pi-ai 在 `supportsDeveloperRole: true` 时会发 `developer`。必须设 `false`，让它退回 `system`。

### 4.4 `reasoning_effort`

上游错误文本声称支持 `none、minimal、low、medium、high、xhigh、max`。实测：

| 值 | `glm-5.3` |
| --- | --- |
| `minimal` | ❌ `InferHub.ModelArts.81001.400 API 调用参数有误` |
| `none` | ❌ 同上 |
| `off` | ❌ `reasoning_effort 参数值非法` |
| `low` | ✅ reasoning ≈ 6–17 |
| `medium` / `high` | ✅ |
| `xhigh` | ✅ reasoning ≈ 55 |
| `max` | ✅ reasoning ≈ 60 |
| 不传 | 默认最深，reasoning ≈ 68–88 |

`kimi-k3.1-pro` 和 `deepseek-v4.1-flash-1017` 接受 `none`，但为了目录统一，三个文字模型都只暴露 `low/medium/high/xhigh/max`。

**`minimal` 必须映射成 `null`**：pi-ai 的 `getSupportedThinkingLevels` 会过滤掉 `thinkingLevelMap[level] === null` 的档位，而未映射的档位会被**原样**当作 effort 发出去 —— 也就是说如果只写 `{low:'low', medium:'medium', ...}` 而漏了 `minimal`，DSH 仍会把 `minimal` 发给上游，然后收到 400。

### 4.5 思考开关用 zai 格式

`thinking:{type:"enabled",clear_thinking:false}` + `reasoning_effort:"high"` 在三个文字模型和两个多模态模型上都通；`thinking:{type:"disabled"}` 在五个上都通。

在 `glm-5.3` 上对比：

```
thinking:{type:"disabled"}  → completion_tokens=3,  reasoning_tokens=undefined
默认（不传）                → reasoning_tokens=52~55
```

说明 `disabled` 确实生效。所以用 `compat.thinkingFormat: "zai"`：DSH 的「off」档会发 `thinking:{type:"disabled"}`，而不是发一个上游不认的 `reasoning_effort` 字符串。

**但 `thinking:{type:"disabled"}` 并非对所有模型都管用。** 逐个模型实测（同一道题，看 `reasoning_tokens`）：

| 模型 | `thinking:{type:"disabled"}` | 不传 thinking |
| --- | --- | --- |
| `glm-5.3` | ✅ reasoning = `undefined`（完全不思考） | reasoning ≈ 52–55 |
| `deepseek-v4.1-flash-1017` | ✅ reasoning = `undefined` | 会思考 |
| `kimi-k3.1-pro` | ⚠️ reasoning ≈ 68–70，**仍在思考** | reasoning ≈ 79 |

`kimi-k3.1-pro` 试过 `reasoning_effort:"none"`（reasoning ≈ 32）也一样，说明这个模型的思考是**不可关闭**的。这是模型侧行为，插件不掩盖：目录里它仍然提供 `off` 档，但选了也照样会思考。用户如果确实需要零思考，应改用 `glm-5.3` 或 `deepseek-v4.1-flash-1017`。

### 4.6 多模态

只有 `kimi-k2.6-vl` 和 `Qwen3-VL-235B` 接受 `image_url` data-URI（实测让它们认 1×1 PNG 的颜色，答 "Black."）。

给文字模型发图片时：

```
HTTP 200
data:{"text":"[DONE]","error_code":"InferHub.001001020.406",
      "error_msg":"The request model is not multimodal"}
```

**HTTP 状态是 200**，错误藏在流里。客户端只会看到一条被截断的流；更糟的是这条图片会留在历史里，让之后**每个**请求都同样失败。所以 `stripUnsupportedImages` 把图片块替换成一句文字说明，会话就还能继续。

### 4.7 工具调用

完整往返验证通过，包括 assistant 的 `tool_calls` 和 `role:"tool"` 的结果。流式 delta 里出现过的键：`role`、`reasoning_content`、`content`、`tool_calls`；`finish_reason` 为 `tool_calls`。所以 pi-ai 的原生工具调用路径可以直接用，不需要额外适配。

### 4.8 SSE 帧形状

```
data:{"id":"...","created":...,"object":"chat.completion.chunk","model":"glm-5.3",
      "choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"The"}}],
      "service_tier":"default"}

data:{"id":"...","choices":[{"index":0,"finish_reason":"length",
      "delta":{"role":"assistant","content":""}}],"service_tier":"default"}

data:{"id":"...","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":16,
      "total_tokens":29,"completion_tokens_details":{"reasoning_tokens":16}},
      "service_tier":"default"}

data:[DONE]
```

思考内容在 `delta.reasoning_content`，pi-ai 已经认这个字段（`openai-completions.js` 里 `reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"]`）。

### 4.9 带内错误三种形状

```
{"text":"[DONE]","error_code":"...","error_msg":"..."}
{"error":{"message":"...","code":"..."}}
{"code":"...","message":"..."}            ← 没有 choices
```

`SseTranslator` 三种都认，统一翻成：

```
data: {"error":{"message":"...","type":"upstream_error","code":"...","param":null}}
```

然后停止转发。OpenAI SDK 遇到顶层 `data.error` 会抛 `APIError`，所以真实原因能出现在界面上，而不是变成一条静默截断。

### 4.10 会话并发上限

上游按账号限制并发会话（3 个）。每请求生成新 session id 会在三次调用后耗尽配额。所以整个进程共用一个固定 `sessionId`，并用 30 秒一次的心跳保活。

心跳本身是**尽力而为**：上游对 `PUT /snap-manager/v1/chat-session/heartbeat` 的 `status` 字段校验很严（`wsf.validator.session.status`），但失败不影响聊天 —— 固定 session id 已经解决了主要问题，心跳只是延长占位时间。

## 5. 边界：不做什么

- **不代理其他厂商**。要接别家，装别的连接器插件。
- **不改 DSH 的模型选择逻辑**。插件只注册一个 provider，选择权在用户。
- **不在浏览器里碰密钥**。浏览器半部分只读 `/plugins/dsh-connect-codearts/status` 的脱敏结果（AK 只显示首尾四位）。
- **不自动重试**。失败就如实报错，重试策略归 DSH 的 retry policy 管，插件不越权。
- **不做模型名猜测**。目录是白名单，不是「从上游拉全量再过滤」。

## 6. 已知限制

- 只支持流式请求（`stream: true`）。非流式直接 400 —— DSH 从来不用非流式，所以这不是实际缺口。
- 不支持 `store`、`n > 1`、`prompt_cache_retention` 这类上游不认的参数（发了也会被忽略，插件不发）。
- 区域写进主机名，所以只能填 `snap-access` 覆盖的区域。
- 模型目录是静态的。上游新增模型时需要改 `lib/index.js` 的 `CODEARTS_MODELS`，或通过设置的 `models` 字段覆盖启用子集（但覆盖不了元数据）。
- **`kimi-k3.1-pro` 的思考关不掉**（详见 §4.5）。插件照常提供 `off` 档，但上游仍然会思考，`reasoning_tokens` 不为零。这是模型侧行为，插件不做假动作去掩盖。
