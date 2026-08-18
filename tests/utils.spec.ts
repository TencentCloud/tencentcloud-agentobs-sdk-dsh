import { describe, expect, it } from 'vitest'
import { newTraceId, newSpanId, msToNanoStr, durationNanoStr, durationMs, toAttrString, safeStringify } from '../src/utils.js'

describe('utils', () => {
  it('generates trace IDs of 32 hex chars', () => {
    const id = newTraceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('generates span IDs of 16 hex chars', () => {
    const id = newSpanId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('converts ms to nanosecond epoch string', () => {
    const result = msToNanoStr(1000)
    expect(result).toBe('1000000000')
  })

  it('calculates duration in nanoseconds', () => {
    const result = durationNanoStr(1000, 2000)
    expect(result).toBe('1000000000')
  })

  it('returns 0 duration for negative difference', () => {
    const result = durationNanoStr(2000, 1000)
    expect(result).toBe('0')
  })

  it('calculates duration in milliseconds', () => {
    expect(durationMs(1000, 2500)).toBe(1500)
    expect(durationMs(2000, 1000)).toBe(0)
  })

  it('converts various types to attribute strings', () => {
    expect(toAttrString('hello')).toBe('hello')
    expect(toAttrString(42)).toBe('42')
    expect(toAttrString(true)).toBe('true')
    expect(toAttrString(null)).toBe('')
    expect(toAttrString(undefined)).toBe('')
    expect(toAttrString({ key: 'value' })).toBe('{"key":"value"}')
  })

  it('safely serializes values with circular references', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj['self'] = obj
    // safeStringify should not throw
    const result = safeStringify(obj)
    expect(typeof result).toBe('string')
  })
})
