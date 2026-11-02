# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-11-02

首个版本。

### 新增

- **接入华为云 CodeArts / ModelArts Studio（MaaS）**：插件在本机回环地址起一个 OpenAI 兼容端点，自动完成 `SDK-HMAC-SHA256` 签名后转发到 `snap-access.<region>.myhuaweicloud.com`，不再需要手工运行 Python 签名代理。
- **五个实测可服务的模型**：`glm-5.3`、`kimi-k3.1-pro`、`deepseek-v4.1-flash-1017`、`kimi-k2.6-vl`、`Qwen3-VL-235B`。
- **多模态支持**：`kimi-k2.6-vl` 与 `Qwen3-VL-235B` 接受图片输入。
- **推理档位**：`low / medium / high / xhigh / max`；关闭思考时发送 `thinking:{type:"disabled"}`。
- **带内错误翻译**：把上游「HTTP 200 + 错误事件」翻译成标准 OpenAI 错误帧，真实原因可见。
- **图片自动降级**：给文字模型发图片时折叠成文字说明，避免一条坏消息永久污染会话。
- **会话保活**：固定 session id + 周期心跳，绕开每账号 3 个并发会话的上限。
- **设置页卡片**：显示凭据状态（AK 脱敏）、区域、上游端点与模型清单，可手动刷新。
- **输入框胶囊读数**：仅在本插件作为当前 provider 时显示凭据就绪状态。
- **17 项端到端自测**：覆盖签名、凭据、图片折叠、带内错误识别、回环端点鉴权，以及六项真实上游调用。

### 设计要点

- `compat.maxTokensField: "max_tokens"` —— 上游忽略 `max_completion_tokens`。
- `compat.supportsDeveloperRole: false` —— 上游拒绝 `role: "developer"`。
- `compat.thinkingFormat: "zai"` —— 关闭思考时用 `thinking` 对象而非非法字符串。
- `thinkingLevelMap.minimal = null` —— 上游 `glm-5.3` 对 `minimal` 回 400，且 pi-ai 会原样透传未映射档位。

### 已知限制

- `kimi-k3.1-pro` 的思考无法关闭：`thinking:{type:"disabled"}` 与 `reasoning_effort:"none"` 实测仍有 reasoning token。这是模型侧行为，插件如实暴露而不掩盖。
