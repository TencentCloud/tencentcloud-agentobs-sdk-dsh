import z from '@deepseek-ai/schemastery'

/** Runtime configuration accepted by the bundle's Cordis row. */
export interface Config {
  /** Disable all collection without removing the bundle. */
  enabled: boolean
  /** CLS API endpoint (e.g. ap-guangzhou.cls.tencentcs.com). */
  endpoint?: string
  /** CLS log topic ID. */
  topicId?: string
  /** Tencent Cloud SecretId. */
  secretId?: string
  /** Tencent Cloud SecretKey. */
  secretKey?: string
  /** Tencent Cloud UIN (digits only) for authless (weak auth) upload. Mutually exclusive with secretId/secretKey. */
  uin?: string
  /** Service name for CLS resource identification. */
  serviceName?: string
  /** Additional string-valued resource attributes injected into every span. */
  resourceAttributes: Record<string, string>
  /** Capture prompts, responses, tool arguments and results. Off by default. */
  captureContent?: boolean
  /** Maximum serialized characters retained for any captured content attribute. */
  contentMaxChars: number
  /** Maximum number of spans in one batch upload. */
  batchMaxSize: number
  /**
   * Maximum serialized bytes per batch upload.
   *
   * Must stay below `CONST_MAX_PUT_SIZE` in tencentcloud-cls-sdk-js (19 MB since
   * 1.1.1), which the SDK enforces locally: an oversize LogGroup throws
   * `InvalidLogSize` before any request is sent, so retrying can never help.
   * The default leaves headroom because `estimateSpanBytes` undercounts — it
   * omits CLS field keys and JSON escape growth inside `attribute`.
   */
  maxBatchBytes: number
  /** Maximum queue size before dropping oldest spans (backpressure). */
  maxQueueSize: number
  /** Flush interval in milliseconds. */
  flushIntervalMs: number
  /** Maximum retry attempts per batch. */
  retryTimes: number
  /** Emit plugin lifecycle diagnostics through the DSH logger. */
  debug: boolean
}

/** Cordis/Schemastery schema with privacy-safe defaults. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.string(),
  topicId: z.string(),
  secretId: z.string(),
  secretKey: z.string(),
  uin: z.string(),
  serviceName: z.string(),
  resourceAttributes: z.dict(z.string()).default({}),
  captureContent: z.boolean(),
  contentMaxChars: z.number().step(1).min(1).default(128_000),
  batchMaxSize: z.number().step(1).min(1).default(32),
  maxBatchBytes: z.number().step(1).min(1024).default(10 * 1024 * 1024),
  maxQueueSize: z.number().step(1).min(1).default(2048),
  flushIntervalMs: z.number().step(1).min(1).default(5_000),
  retryTimes: z.number().step(1).min(0).default(3),
  debug: z.boolean().default(false),
})

const CONTENT_CAPTURE_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'
const CONTENT_DISABLE_MODES = new Set(['FALSE', 'NO', 'OFF', 'DISABLED', '0'])

/**
 * Resolve the content capture switch.
 * Default: enabled (true). Set to false explicitly or via env var to disable.
 * Explicit plugin setting always wins. When omitted, check env var.
 */
export function resolveCaptureContent(
  configured: boolean | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (configured !== undefined) return configured
  const mode = environment[CONTENT_CAPTURE_ENV]?.trim().toUpperCase()
  if (mode !== undefined && CONTENT_DISABLE_MODES.has(mode)) return false
  return true
}

/** Resolve all CLS config from plugin settings + environment variables. */
export interface ResolvedClsConfig {
  endpoint: string
  topicId: string
  secretId: string
  secretKey: string
  uin: string
  serviceName: string
  resourceAttributes: Record<string, string>
  captureContent: boolean
  contentMaxChars: number
  batchMaxSize: number
  maxBatchBytes: number
  maxQueueSize: number
  flushIntervalMs: number
  retryTimes: number
  debug: boolean
}

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` env var (comma-separated key=value pairs).
 */
function parseResourceAttributesEnv(env: string | undefined): Record<string, string> {
  if (!env) return {}
  const result: Record<string, string> = {}
  for (const pair of env.split(',')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx <= 0) continue
    const key = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

export type ResolveResult =
  | ResolvedClsConfig
  | { missing: string[] }

export function resolveClsConfig(config: Config): ResolveResult {
  const endpoint = config.endpoint || process.env['CLS_ENDPOINT'] || ''
  const topicId = config.topicId || process.env['CLS_TOPIC_ID'] || ''
  const secretId = config.secretId || process.env['CLS_SECRET_ID'] || ''
  const secretKey = config.secretKey || process.env['CLS_SECRET_KEY'] || ''
  const uin = config.uin || process.env['CLS_UIN'] || ''
  const serviceName = config.serviceName
    || process.env['CLS_SERVICE_NAME']
    || process.env['OTEL_SERVICE_NAME']
    || 'deepseek-harness'

  // Strong auth requires both secretId and secretKey; weak (authless) auth
  // requires a digits-only UIN. The two are mutually exclusive.
  const hasStrongAuth = secretId !== '' && secretKey !== ''
  const hasWeakAuth = uin !== '' && /^\d+$/.test(uin)

  if (!endpoint || !topicId || (!hasStrongAuth && !hasWeakAuth)) {
    const missing: string[] = []
    if (!endpoint) missing.push('CLS_ENDPOINT')
    if (!topicId) missing.push('CLS_TOPIC_ID')
    if (!hasStrongAuth && !hasWeakAuth) {
      if (uin !== '') {
        missing.push('CLS_UIN (must be a digits-only string)')
      } else {
        missing.push('CLS_SECRET_ID + CLS_SECRET_KEY (or CLS_UIN)')
      }
    }
    return { missing }
  }

  // Merge: env OTEL_RESOURCE_ATTRIBUTES < plugin resourceAttributes (plugin wins)
  const envAttrs = parseResourceAttributesEnv(process.env['OTEL_RESOURCE_ATTRIBUTES'])
  const resourceAttributes: Record<string, string> = { ...envAttrs, ...config.resourceAttributes }

  return {
    endpoint,
    topicId,
    secretId,
    secretKey,
    uin,
    serviceName,
    resourceAttributes,
    captureContent: resolveCaptureContent(config.captureContent),
    contentMaxChars: config.contentMaxChars,
    batchMaxSize: config.batchMaxSize,
    maxBatchBytes: config.maxBatchBytes,
    maxQueueSize: config.maxQueueSize,
    flushIntervalMs: config.flushIntervalMs,
    retryTimes: config.retryTimes,
    debug: config.debug,
  }
}
