import { describe, expect, it, vi } from 'vitest'
import { networkInterfaces } from 'node:os'
import { newTraceId, newSpanId, msToNanoStr, durationNanoStr, durationMs, toAttrString, safeStringify, getLocalIp } from '../src/utils.js'

// `node:os` exports are non-configurable, so the module is mocked instead of spied on.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) }
})

const mockedInterfaces = vi.mocked(networkInterfaces)

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

  it('returns an external IPv4 address when one exists', () => {
    mockedInterfaces.mockReturnValueOnce({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    } as unknown as ReturnType<typeof networkInterfaces>)

    expect(getLocalIp()).toBe('192.168.1.20')
  })

  it('falls back to loopback rather than a hostname when no IPv4 is found', () => {
    // The CLS SDK requires a non-empty sourceIp but never validates its format,
    // so a hostname fallback would be stored as a malformed IP with no error.
    mockedInterfaces.mockReturnValueOnce({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    } as unknown as ReturnType<typeof networkInterfaces>)

    expect(getLocalIp()).toBe('127.0.0.1')
  })
})
