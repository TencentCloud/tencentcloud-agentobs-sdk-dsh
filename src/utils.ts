import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'

/** Fallback source IP, matching the CLS SDK's own `CONST_LOCAL_IP`. */
const LOOPBACK_IP = '127.0.0.1'

/** Generate 32-char hex trace ID. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

/** Generate 16-char hex span ID. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/** Convert millisecond epoch to nanosecond epoch string. */
export function msToNanoStr(ms: number): string {
  return String(BigInt(Math.max(0, Math.round(ms))) * 1_000_000n)
}

/** Calculate duration in nanoseconds between two ms timestamps. */
export function durationNanoStr(startMs: number, endMs: number): string {
  const diff = Math.max(0, endMs - startMs)
  return String(BigInt(Math.round(diff)) * 1_000_000n)
}

/** Calculate duration in milliseconds. */
export function durationMs(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs))
}

/**
 * Best-effort local IPv4 address for the CLS `sourceIp` field.
 *
 * Falls back to loopback rather than the hostname: the CLS SDK requires a
 * non-empty value but never validates its format, so a hostname would be stored
 * as a malformed IP with no error anywhere.
 */
export function getLocalIp(): string {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address
      }
    }
  }
  return LOOPBACK_IP
}

/** Safe JSON stringify. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 0)
  } catch {
    return String(value)
  }
}

/** Convert any value to string for CLS attribute. */
export function toAttrString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return safeStringify(value)
}
