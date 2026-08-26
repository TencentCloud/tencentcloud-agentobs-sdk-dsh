<p align="center">
  <img src="https://raw.githubusercontent.com/TencentCloud/tencentcloud-agentobs-sdk-dsh/main/assets/banner.png" alt="Tencent Cloud CLS observability for DeepSeek Harness" width="820">
</p>

# Tencent Cloud Service CLS observability for DeepSeek Harness

[English](./README.en.md) | 简体中文

`tencentcloud-agentobs-sdk-dsh` 是一个 DeepSeek Harness (DSH) 可观测插件，直接将 GenAI trace 数据上报到腾讯云日志服务 (CLS)。

它观察 DSH 原生的 session、agent loop、LLM stream 和 tool 生命周期，将其转换为腾讯云AI Agent可观测规范的 5 层 span 层级模型（entry → agent → step → chat → tool），并通过 `tencentcloud-cls-sdk-js` 直接上报到 CLS，**无需额外部署 OTLP 收集器或 sidecar**。

## 数据模型

```text
DSH session/event + llm/stream
                │
                ▼
      CLS Trace Coordinator
                │
                ▼
    CLS 5-layer span model
    (entry/agent/step/chat/tool)
                │
                ▼
    tencentcloud-cls-sdk-js
                │  Protobuf upload
                ▼
    Tencent Cloud CLS
```

一次 DSH turn 产生的 trace 结构：

```text
ENTRY
└── AGENT (invoke_agent)
    └── STEP (react round_N)
        ├── CHAT (chat model_name)
        └── TOOL (execute_tool tool_name)
```

## 安装

### 前置依赖

全局安装 DeepSeek Harness CLI：

```sh
npm install -g @deepseek-ai/dsh
```

### 安装插件

```sh
dsh plugin --profile web add tencentcloud-agentobs-sdk-dsh
dsh plugin --profile headless add tencentcloud-agentobs-sdk-dsh
dsh plugin --profile harness add tencentcloud-agentobs-sdk-dsh
```

> **注意**：安装或更新插件后，需要重启 DSH 服务才能生效。

### pnpm 构建脚本问题

pnpm v9+ 默认禁止依赖包运行 install 脚本。如果安装时遇到以下错误：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@6.11.6
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

在对应 profile 目录执行一次即可（后续安装/更新不再需要）：

```sh
cd ~/.dsh/profiles/web
echo "enable-scripts=true" >> .npmrc
pnpm install
```


headless / harness profile 同理，将路径改为 `~/.dsh/profiles/headless` 或 `~/.dsh/profiles/harness`。

### 卸载插件

```sh
dsh plugin --profile web remove tencentcloud-agentobs-sdk-dsh
dsh plugin --profile headless remove tencentcloud-agentobs-sdk-dsh
dsh plugin --profile harness remove tencentcloud-agentobs-sdk-dsh
```

## 配置

### 环境变量（推荐）

```sh
export CLS_ENDPOINT=ap-guangzhou.cls.tencentcs.com
export CLS_TOPIC_ID=your-topic-id
export CLS_SERVICE_NAME=dsh-agent

# 鉴权方式二选一：
# 方式 1（强鉴权）：SecretId + SecretKey
export CLS_SECRET_ID=your-secret-id
export CLS_SECRET_KEY=your-secret-key
# 方式 2（免鉴权/弱鉴权）：仅提供纯数字 UIN
# export CLS_UIN=your-uin

dsh --profile web
```

### 插件配置文件

编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: cls-observability
  config:
    endpoint: ap-guangzhou.cls.tencentcs.com
    topicId: your-topic-id
    # 强鉴权：SecretId + SecretKey
    secretId: your-secret-id
    secretKey: your-secret-key
    # 或免鉴权（弱鉴权）：仅提供纯数字 UIN（与 SecretId/SecretKey 二选一）
    # uin: "100000000000"
    serviceName: dsh-agent
    captureContent: true
    batchMaxSize: 32
    flushIntervalMs: 5000
    debug: false
```

显式插件配置优先于环境变量。

### 关闭内容捕获

默认情况下，prompts、responses、tool arguments/results **会**附加到 span。如需关闭：

```sh
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
dsh --profile web
```

或在插件配置中设置 `captureContent: false`。

## 配置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 禁用采集但不卸载插件 |
| `endpoint` | `CLS_ENDPOINT` | CLS API 接入点 |
| `topicId` | `CLS_TOPIC_ID` | CLS 日志主题 ID |
| `secretId` | `CLS_SECRET_ID` | 腾讯云 SecretId（强鉴权，与 `uin` 二选一） |
| `secretKey` | `CLS_SECRET_KEY` | 腾讯云 SecretKey（强鉴权，与 `uin` 二选一） |
| `uin` | `CLS_UIN` | 免鉴权（弱鉴权）上报的腾讯云 UIN（纯数字，与 SecretId/SecretKey 二选一） |
| `serviceName` | `deepseek-harness` | 服务名 |
| `captureContent` | `true` | 捕获 prompts/responses/tool 内容（设为 `false` 关闭） |
| `contentMaxChars` | `128000` | 单个内容属性最大字符数 |
| `batchMaxSize` | `32` | 每批上报最大 span 数 |
| `maxBatchBytes` | `10485760` | 每批上报最大字节数（10MB）。必须小于 SDK 的 19MB 硬限制，否则整批会在本地被拒 |
| `maxQueueSize` | `2048` | 队列上限，超限丢弃最旧 span |
| `flushIntervalMs` | `5000` | 定时刷新间隔（毫秒） |
| `retryTimes` | `3` | 上报重试次数 |
| `debug` | `false` | 启用调试日志 |

## 隐私说明

内容捕获默认开启。源代码、凭证、个人数据等敏感内容可能被发送到 CLS。如需关闭，设置 `captureContent: false` 或环境变量 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`。请确保 CLS 的数据保留和访问控制策略符合安全要求。

## 兼容性

| 组件 | 支持范围 |
| --- | --- |
| DeepSeek Harness | `>=0.1.0-rc.6 <0.2.0` |
| Node.js | `>=18.0.0` |

## 开发

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
```

## License

[Apache-2.0](LICENSE)
