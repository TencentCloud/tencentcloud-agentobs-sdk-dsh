# Tencent Cloud Service CLS observability for DeepSeek Harness

English | [简体中文](./README.md)

`tencentcloud-agentobs-sdk-dsh` is a DeepSeek Harness (DSH) observability plugin that reports GenAI trace data directly to Tencent Cloud Log Service (CLS).

It observes DSH's native session, agent loop, LLM stream, and tool lifecycles, converts them into CLS's standard 5-layer span hierarchy model (entry → agent → step → chat → tool), and uploads them directly to CLS via `tencentcloud-cls-sdk-js` — **no additional OTLP collector or sidecar deployment required**.

## Data model

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

The trace structure produced by a single DSH turn:

```text
ENTRY
└── AGENT (invoke_agent)
    └── STEP (react round_N)
        ├── CHAT (chat model_name)
        └── TOOL (execute_tool tool_name)
```

## Installation

### Prerequisites

Install the DeepSeek Harness CLI globally:

```sh
npm install -g @deepseek-ai/dsh
```

### Install the plugin

```sh
dsh plugin --profile web add tencentcloud-agentobs-sdk-dsh
dsh plugin --profile headless add tencentcloud-agentobs-sdk-dsh
dsh plugin --profile harness add tencentcloud-agentobs-sdk-dsh
```

> **Note**: After installing or updating the plugin, restart the DSH service for changes to take effect.

### pnpm build script issues

pnpm v9+ blocks dependency packages from running install scripts by default. If you encounter the following error during installation:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@6.11.6
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

Run the following once in the corresponding profile directory (no longer needed for subsequent installs/updates):

```sh
cd ~/.dsh/profiles/web
echo "enable-scripts=true" >> .npmrc
pnpm install
```

For the headless / harness profiles, do the same with the path changed to `~/.dsh/profiles/headless` or `~/.dsh/profiles/harness`.

### Uninstall the plugin

```sh
dsh plugin --profile web remove tencentcloud-agentobs-sdk-dsh
dsh plugin --profile headless remove tencentcloud-agentobs-sdk-dsh
dsh plugin --profile harness remove tencentcloud-agentobs-sdk-dsh
```

## Configuration

### Environment variables (recommended)

```sh
export CLS_ENDPOINT=ap-guangzhou.cls.tencentcs.com
export CLS_TOPIC_ID=your-topic-id
export CLS_SERVICE_NAME=dsh-agent

# Authentication (choose one):
# Option 1 (strong auth): SecretId + SecretKey
export CLS_SECRET_ID=your-secret-id
export CLS_SECRET_KEY=your-secret-key
# Option 2 (authless / weak auth): digits-only UIN
# export CLS_UIN=your-uin

dsh --profile web
```

### Plugin config file

Edit `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: cls-observability
  config:
    endpoint: ap-guangzhou.cls.tencentcs.com
    topicId: your-topic-id
    # strong auth: SecretId + SecretKey
    secretId: your-secret-id
    secretKey: your-secret-key
    # or authless (weak auth): digits-only UIN (mutually exclusive with SecretId/SecretKey)
    # uin: "100000000000"
    serviceName: dsh-agent
    captureContent: true
    batchMaxSize: 32
    flushIntervalMs: 5000
    debug: false
```

Explicit plugin configuration takes precedence over environment variables.

### Disable content capture

By default, prompts, responses, and tool arguments/results **are** attached to spans. To disable this:

```sh
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
dsh --profile web
```

Or set `captureContent: false` in the plugin configuration.

## Configuration options

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Disable collection without uninstalling the plugin |
| `endpoint` | `CLS_ENDPOINT` | CLS API endpoint |
| `topicId` | `CLS_TOPIC_ID` | CLS log topic ID |
| `secretId` | `CLS_SECRET_ID` | Tencent Cloud SecretId (strong auth, mutually exclusive with `uin`) |
| `secretKey` | `CLS_SECRET_KEY` | Tencent Cloud SecretKey (strong auth, mutually exclusive with `uin`) |
| `uin` | `CLS_UIN` | Tencent Cloud UIN for authless (weak auth) upload (digits only, mutually exclusive with SecretId/SecretKey) |
| `serviceName` | `deepseek-harness` | Service name |
| `captureContent` | `true` | Capture prompts/responses/tool content (set to `false` to disable) |
| `contentMaxChars` | `128000` | Maximum characters per content attribute |
| `batchMaxSize` | `32` | Maximum spans per upload batch |
| `maxQueueSize` | `2048` | Queue limit; oldest spans are dropped when exceeded |
| `flushIntervalMs` | `5000` | Scheduled flush interval (milliseconds) |
| `retryTimes` | `3` | Upload retry count |
| `debug` | `false` | Enable debug logging |

## Privacy

Content capture is enabled by default. Sensitive content such as source code, credentials, and personal data may be sent to CLS. To disable it, set `captureContent: false` or the environment variable `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`. Ensure that CLS data retention and access control policies meet your security requirements.

## Compatibility

| Component | Supported range |
| --- | --- |
| DeepSeek Harness | `>=0.1.0-rc.6 <0.2.0` |
| Node.js | `>=18.0.0` |

## Development

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
```

## License

[Apache-2.0](LICENSE)
