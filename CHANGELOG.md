# Changelog

本项目所有值得注意的变更都记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-26

### 变更

- **上报层不再裁剪 span 内容。** 移除 flusher 中的内容降级逻辑，捕获到的
  prompt、响应、工具参数与结果保持逐字节一致。超出 `maxBatchBytes` 的 span
  会原样上报并输出告警，而不再被静默改写。

  被裁剪的内容与"本来就很短的 prompt"在分析时无法区分，因此选择让超限风险显式
  可见。内容长度的约束统一由上游 `contentMaxChars` 负责。

  影响：若单个 span 超出 SDK 的 19MB 上限，该 span 会整体丢失（此前会降级保留
  结构与部分内容）。默认配置下不会触发；若曾显著调高 `contentMaxChars`，请一并
  确认 `maxBatchBytes`。

- 依赖 `tencentcloud-cls-sdk-js` 由 `1.1.0` 升级至 `1.1.1`，单次上报上限由 1MB
  提升至 19MB。
- 新增 `maxBatchBytes` 配置项，默认 10MB。该值必须低于 SDK 的上限，否则整批数据
  会在本地被拒绝。

### 修复

- **进程退出时可能丢失最后一批 span。** `flush` 此前在已有刷新进行中时直接返回，
  导致 `stop` 误判队列无进展而提前结束。现在并发调用会汇入进行中的任务。同一问题
  也会让定时刷新被静默跳过。
- **SDK 本地体积拒绝被误报为网络故障。** SDK 在发送前校验体积并抛出
  `InvalidLogSize`，该错误不带状态码，此前被记录为 `send failed (unknown)`，看似
  网络抖动，实为重试永远无法恢复的配置问题。现在单独识别并提示应调整的配置项。
- **`sourceIp` 可能写入非 IP 值。** 无可用外部 IPv4 时的回退值由主机名改为
  `127.0.0.1`。CLS SDK 要求该字段非空但不校验格式，主机名会被静默存为畸形 IP。
- **CLS 客户端初始化失败会拖垮宿主进程。** 客户端在构造时校验参数，此前该异常会
  从插件的 `apply` 抛出。现在插件降级为空操作并告警，且在注册监听器之前退出。

## [0.0.4] - 2026-08-25

### 修复

- CHAT span 的请求内容限定为当前 turn 的上下文，不再重复携带此前 turn 的历史。
- ENTRY 与 AGENT span 的输入仅保留用户的直接请求，排除 DSH 注入的合成上下文
  （运行时快照、技能目录等）。
- ENTRY 与 AGENT span 的输出仅上报最终回答，不再混入工具循环中的中间消息。

## [0.0.2] - 2026-08-25

### 新增

- 支持免鉴权（弱鉴权）上报：配置 `uin`（或 `CLS_UIN`）即可，与
  `secretId`/`secretKey` 二选一。
- 上报请求带上标识 SDK 版本的 User-Agent。
- 提供中英文 README 与 `cordis.patch.example.yml` 示例配置。

### 修复

- 移除上报层 32KB 的字段截断，避免内容被意外截短；长度控制交由
  `contentMaxChars` 统一处理。

## [0.0.1] - 2026-08-18

### 新增

- 首个版本。观测 DSH 的会话、Agent 循环、LLM 流与工具生命周期，转换为 CLS 的
  五层 GenAI span（entry → agent → step → chat/tool）并直接上报腾讯云 CLS，
  无需 OTLP collector 或 sidecar。

[0.1.0]: https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh/compare/v0.0.4...v0.1.0
[0.0.4]: https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh/compare/v0.0.2...v0.0.4
[0.0.2]: https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh/releases/tag/v0.0.1
