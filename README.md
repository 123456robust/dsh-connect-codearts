# dsh-connect-codearts

把 **华为云 CodeArts / ModelArts Studio（MaaS）** 上的模型接入 [DSH](https://github.com/deepseek-ai/dsh)。

插件在本机回环地址起一个 OpenAI 兼容端点，自动完成华为云 `SDK-HMAC-SHA256` 签名后转发上游 —— 你不再需要另跑一个 Python 签名代理，也不用在 `cordis.patch.yml` 里手写 `apiKeyEnv`。

> 结构参考 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 与 [@dmh2002/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder)（均为 MIT）。本插件与华为云官方无关。

---

## 它解决什么问题

华为云的 `snap-access` 端点要求每个请求带一组**动态签名头**（`x-sdk-date`、`x-ot-session-id`、`Authorization: SDK-HMAC-SHA256 ...`）。而 DSH 的 provider 配置只支持静态 `apiKeyEnv` —— 一个固定的字符串没法表达一个逐请求变化的签名。

本插件的做法：

```
DSH  ──OpenAI 协议──▶  127.0.0.1:<随机端口>  ──签名后──▶  snap-access.<region>.myhuaweicloud.com
                        （本插件启动，一次性密钥保护）
```

pi-ai 照常用标准的 `openai-completions` 协议；shim 收到请求后重新签名、转发、把 SSE 逐行回灌。所有密钥都在本进程内，不落盘、不进浏览器。

## 功能

- **五个实测可服务的模型**，按租户真实可用性筛选过
- **多模态**：`kimi-k2.6-vl` 与 `Qwen3-VL-235B` 可以读图
- **推理档位**：`low / medium / high / xhigh / max`，关掉思考时发 `thinking:{type:"disabled"}`（`glm-5.3`、`deepseek-v4.1-flash-1017` 生效；`kimi-k3.1-pro` 思考关不掉，见设计说明 §4.5）
- **带内错误翻译**：上游用 HTTP 200 + 一条错误事件报错，插件把它翻成标准 OpenAI 错误帧，界面上能看到真实原因
- **图片自动降级**：给文字模型发图片时折叠成文字说明，避免一条坏消息永久污染会话
- **会话保活**：固定 session id + 周期心跳，绕开「每账号 3 个并发会话」的上限
- **设置页卡片** + **输入框胶囊读数**：显示凭据状态、区域、上游端点与模型清单

## 内置模型

| 模型 | 上下文 | 最大输出 | 多模态 |
| --- | --- | --- | --- |
| `glm-5.3` | 1,048,576 | 65,536 | — |
| `kimi-k3.1-pro` | 262,144 | 32,768 | — |
| `deepseek-v4.1-flash-1017` | 262,144 | 32,768 | — |
| `kimi-k2.6-vl` | 262,144 | 32,768 | ✓ |
| `Qwen3-VL-235B` | 131,072 | 16,384 | ✓ |

目录是**实测**的：同一租户下 `deepseek-v3.2`、`qwen3-max`、`glm-4.6`、`kimi-k2` 都返回 404（模型未注册）。改目录前请先跑 `npm run probe`。

## 安装

### 1. 准备华为云凭据

在 `~/.config/huaweicloud/credentials.json` 写入：

```json
{
  "ak": "你的 AK",
  "sk": "你的 SK",
  "securityToken": "",
  "region": "cn-north-4"
}
```

或用环境变量（优先级更高）：

```bash
export CODEARTS_AK=...
export CODEARTS_SK=...
export CODEARTS_REGION=cn-north-4
```

AK/SK 在[华为云控制台 → 我的凭证 → 访问密钥](https://console.huaweicloud.com/iam/)创建。

### 2. 装插件

```bash
git clone <本仓库地址> dsh-connect-codearts
```

然后在 DSH 里用插件管理器安装这个目录（`plugin_manager` 的 `install_bundle`，`target` 填绝对路径），或把目录放进 profile 的 `node_modules` 后重启 DSH。

装好后重启 DSH，模型选择器里会出现 **CodeArts (HuaweiCloud MaaS)**。

## 配置

设置 → 插件 → `dsh-connect-codearts`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `region` | `cn-north-4` | 华为云区域。区域会写进上游主机名。 |
| `credentialsFile` | 空 | 凭据文件路径。留空用默认位置。 |
| `models` | 全部五个 | 启用的模型 id，改完即时生效。 |
| `heartbeat` | `true` | 是否发会话心跳。失败不影响聊天。 |

## 自测

```bash
npm test            # 17 项，含真实上游调用
npm run test:offline # 跳过联网用例
npm run probe glm-5.3 "你好"  # 单独打一发上游
```

`npm test` 会真起一个 shim 并请求华为云上游，需要本机已有凭据。

## 设计要点

### 签名

```
CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQuery \n
                   CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
StringToSign     = "SDK-HMAC-SHA256" \n x-sdk-date \n hex(sha256(CanonicalRequest))
Signature        = hex(HMAC-SHA256(key=SK, msg=StringToSign))
```

`CanonicalURI` 必须以 `/` 结尾，`CanonicalQuery` 为空串，`SignedHeaders` 按名字**大小写不敏感**排序后小写分号拼接。完整实现见 [`lib/signer.js`](lib/signer.js)。

### 三个必须覆盖的 compat 开关

这三个不是可选项，是被实测逼出来的：

| 开关 | 不设会怎样 |
| --- | --- |
| `maxTokensField: "max_tokens"` | 上游忽略 `max_completion_tokens`（实测 `=8` 却产出 622 token），输出完全不封顶 |
| `supportsDeveloperRole: false` | 上游拒绝 `role: "developer"`，回 `InferHub.001001044.400` |
| `thinkingFormat: "zai"` | 关思考时会发一个非法的 `reasoning_effort` 字符串而不是 `thinking:{type:"disabled"}` |

另外 `thinkingLevelMap` 里把 `minimal` 显式设成 `null`：`glm-5.3` 收到 `reasoning_effort: "minimal"` 会回 400，而 pi-ai 对未映射的档位会**原样**把档位名发出去。设成 `null` 后该档位从可选列表消失。

### 为什么图片要折叠

给文字模型发图片，上游回的是 **HTTP 200 + 一条带内错误**（`InferHub.001001020.406 The request model is not multimodal`）。客户端只看到一条被截断的流；更糟的是这条图片会一直留在历史里，让之后每个请求都同样失败。折叠成一句文字说明，会话就还能继续。

### 为什么固定 session id

上游按账号限制并发会话数（3 个）。每请求换新 id 会在三次调用后耗尽配额，所以整个进程共用一个固定 id，并用心跳保活。

## 目录结构

```
lib/
  signer.js     # 纯 Node 内置：签名、凭据、SSE 翻译、心跳（可单测）
  shim.js       # 回环 OpenAI 兼容端点（只依赖 signer.js）
  index.js      # DSH Host 半部分：PiAiAdapter、设置、状态路由
  client.js     # 浏览器半部分：设置卡片 + 输入框胶囊
  index.d.ts    # 类型声明
scripts/
  selftest.mjs       # 端到端自测（17 项）
  probe-upstream.mjs # 单发探针
locale/         # zh / en 显示元数据
icons/          # 图标
docs/DESIGN.md  # 设计说明与实测记录
```

## 边界

- 不代理其他厂商的模型
- 不改 DSH 自己的模型选择逻辑
- 不在浏览器里碰任何密钥
- 不自动重试 —— 失败就如实报错，由 DSH 的 retry policy 决定

## 许可

MIT，见 [LICENSE](LICENSE)。
