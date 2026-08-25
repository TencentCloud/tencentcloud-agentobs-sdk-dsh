/**
 * CLS Flusher — uploads CLS spans to Tencent Cloud CLS via tencentcloud-cls-sdk-js.
 *
 * Batched upload with configurable batch size and flush interval.
 * Error handling: 4xx discards (non-retryable), 5xx uses SDK built-in retry.
 */

import { createRequire } from 'node:module'
import type { CLSSpan } from './cls-types.js'
import type { ResolvedClsConfig } from './config.js'
import type { DshLogger } from './dsh-types.js'
import { getLocalIp } from './utils.js'
import { VERSION } from './version.js'

const require = createRequire(import.meta.url)

const DEFAULT_USER_AGENT = `agentobs-dsh-${VERSION}`

// tencentcloud-cls-sdk-js uses CJS exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AsyncClient, LogItem, Content, LogGroup, PutLogsRequest } = require('tencentcloud-cls-sdk-js') as {
  AsyncClient: new (config: Record<string, unknown>) => ClsClient
  LogItem: new () => ClsLogItem
  Content: new (key: string, value: string) => ClsContent
  LogGroup: new () => ClsLogGroup
  PutLogsRequest: new (topicId: string, logGroup: ClsLogGroup) => ClsPutLogsRequest
}

interface ClsClient {
  PutLogs(request: ClsPutLogsRequest): Promise<{ get_request_id?(): string }>
}
interface ClsLogItem {
  pushBack(content: ClsContent): void
  setTime(seconds: number): void
}
interface ClsContent { key: string; value: string }
interface ClsLogGroup {
  addLogs(item: ClsLogItem): void
}
interface ClsPutLogsRequest { topicId: string }

const MAX_BATCH_BYTES = 900 * 1024

export class CLSFlusher {
  private readonly config: ResolvedClsConfig
  private readonly logger: DshLogger
  private client: ClsClient | null = null
  private queue: CLSSpan[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private sentCount = 0
  private failedCount = 0
  private droppedCount = 0

  constructor(config: ResolvedClsConfig, logger: DshLogger) {
    this.config = config
    this.logger = logger
  }

  /** Initialize CLS client and start periodic flushing. */
  start(): void {
    const endpoint = this.config.endpoint.replace(/^https?:\/\//, '')
    this.client = new AsyncClient({
      endpoint,
      secretId: this.config.secretId,
      secretKey: this.config.secretKey,
      uin: this.config.uin,
      user_agent: DEFAULT_USER_AGENT,
      sourceIp: getLocalIp(),
      retry_times: this.config.retryTimes,
    })
    this.flushTimer = setInterval(() => { this.flush().catch(() => {}) }, this.config.flushIntervalMs)
    if (this.config.debug) {
      this.logger.info(`[cls-dsh] flusher initialized → ${endpoint} topic=${this.config.topicId.slice(0, 8)}...`)
    }
  }

  /** Enqueue a span for upload. Drops oldest spans when queue exceeds maxQueueSize. */
  enqueue(span: CLSSpan): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      const dropCount = Math.max(1, Math.floor(this.config.maxQueueSize * 0.1))
      this.queue.splice(0, dropCount)
      this.droppedCount += dropCount
      this.logger.warn(
        `[cls-dsh] queue full (${this.config.maxQueueSize}), dropped ${dropCount} oldest span(s). total dropped=${this.droppedCount}`,
      )
    }
    this.queue.push(span)
    if (this.queue.length >= this.config.batchMaxSize) {
      this.flush().catch(() => {})
    }
  }

  /** Enqueue multiple spans. */
  enqueueBatch(spans: CLSSpan[]): void {
    for (const s of spans) this.enqueue(s)
  }

  /** Flush queued spans to CLS. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true

    try {
      while (this.queue.length > 0) {
        const batch: CLSSpan[] = []
        let batchBytes = 0
        while (this.queue.length > 0 && batch.length < this.config.batchMaxSize) {
          const span = this.queue[0]!
          const spanBytes = this.estimateSpanBytes(span)
          if (batchBytes + spanBytes > MAX_BATCH_BYTES && batch.length > 0) break
          batch.push(this.queue.shift()!)
          batchBytes += spanBytes
        }
        if (batch.length === 0) break

        try {
          await this.send(batch)
          this.sentCount += batch.length
        } catch (err: unknown) {
          this.failedCount += batch.length
          const status = (err as { code?: number; statusCode?: number })?.code
            ?? (err as { code?: number; statusCode?: number })?.statusCode ?? 0
          if (status >= 400 && status < 500) {
            this.logger.warn(
              `[cls-dsh] ${status} (non-retryable), dropped ${batch.length} spans: ${(err as Error).message}`,
            )
          } else {
            this.logger.warn(
              `[cls-dsh] send failed (${status || 'unknown'}), ${batch.length} spans lost: ${(err as Error).message}`,
            )
          }
        }
      }
    } finally {
      this.flushing = false
    }
  }

  /** Stop flushing and send remaining data. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    const maxRetries = 5
    let retries = 0
    while (this.queue.length > 0 && retries < maxRetries) {
      const prevLen = this.queue.length
      await this.flush()
      if (this.queue.length >= prevLen) break
      retries++
    }
    if (this.queue.length > 0) {
      this.logger.warn(`[cls-dsh] stop: ${this.queue.length} span(s) discarded after retries`)
    }
    if (this.config.debug) {
      this.logger.info(`[cls-dsh] flusher stopped. sent=${this.sentCount} failed=${this.failedCount} dropped=${this.droppedCount}`)
    }
  }

  private estimateSpanBytes(span: CLSSpan): number {
    let bytes = 0
    for (const value of Object.values(span)) {
      if (typeof value === 'object' && value !== null) {
        bytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
      } else {
        bytes += Buffer.byteLength(String(value), 'utf8')
      }
    }
    return bytes
  }

  private async send(spans: CLSSpan[]): Promise<void> {
    if (!this.client) throw new Error('CLS client not initialized')

    const logGroup = new LogGroup()
    for (const span of spans) {
      const item = new LogItem()

      // Flatten top-level CLS fields
      const entries: Array<[string, string]> = [
        ['spanKind', span.spanKind],
        ['traceID', span.traceID],
        ['spanID', span.spanID],
        ['parentSpanID', span.parentSpanID],
        ['sessionID', span.sessionID],
        ['agentID', span.agentID],
        ['parentAgentID', span.parentAgentID],
        ['stepID', span.stepID],
        ['name', span.name],
        ['kind', span.kind],
        ['statusCode', span.statusCode],
        ['statusMessage', span.statusMessage],
        ['start', span.start],
        ['end', span.end],
        ['duration', span.duration],
        ['durationMs', span.durationMs],
        ['host', span.host],
        ['service', span.service],
        ['links', span.links],
        ['attribute', JSON.stringify(span.attribute)],
      ]

      for (const [key, value] of entries) {
        item.pushBack(new Content(key, value))
      }

      // Timestamp in seconds
      const startNs = span.start ? BigInt(span.start) : 0n
      const tsSec = startNs > 0n ? Number(startNs / 1_000_000_000n) : Math.floor(Date.now() / 1000)
      item.setTime(tsSec)

      logGroup.addLogs(item)
    }

    const request = new PutLogsRequest(this.config.topicId, logGroup)
    const response = await this.client.PutLogs(request)
    if (this.config.debug) {
      const requestId = response.get_request_id?.() ?? ''
      this.logger.info(`[cls-dsh] uploaded ${spans.length} spans, request_id=${requestId}`)
    }
  }
}
