import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CLSSpan } from '../src/cls-types.js'
import { createCLSSpan } from '../src/cls-types.js'
import { CLSFlusher } from '../src/cls-flusher.js'
import { logger, testResolvedConfig } from './helpers.js'

/** Capture what the CLS client would receive without doing network I/O. */
function stubClient(flusher: CLSFlusher): { sent: CLSSpan[][] } {
  const captured: { sent: CLSSpan[][] } = { sent: [] }
  // `send` is private but is the seam between batching and transport.
  const internal = flusher as unknown as {
    client: unknown
    send(spans: CLSSpan[]): Promise<void>
  }
  internal.client = {}
  internal.send = async (spans: CLSSpan[]): Promise<void> => {
    captured.sent.push(spans.map(s => ({ ...s, attribute: { ...s.attribute } })))
  }
  return captured
}

function spanWithContent(name: string, content: string): CLSSpan {
  const span = createCLSSpan()
  span.spanKind = 'chat'
  span.name = name
  span.traceID = 'a'.repeat(32)
  span.spanID = 'b'.repeat(16)
  span.attribute['gen_ai.input.messages'] = content
  return span
}

/** First span of the first uploaded batch. */
function firstSent(captured: { sent: CLSSpan[][] }): CLSSpan {
  const batch = captured.sent[0]
  if (batch === undefined || batch[0] === undefined) {
    throw new Error('no span was uploaded')
  }
  return batch[0]
}

describe('CLSFlusher oversize handling', () => {
  beforeEach(() => {
    logger.messages.length = 0
  })

  it('sends an oversize span unmodified and warns instead of trimming', async () => {
    const limit = 4096
    const flusher = new CLSFlusher(
      testResolvedConfig({ maxBatchBytes: limit, captureContent: true }),
      logger,
    )
    const captured = stubClient(flusher)

    const huge = 'x'.repeat(limit * 3)
    flusher.enqueue(spanWithContent('chat oversize', huge))
    await flusher.flush()

    expect(captured.sent).toHaveLength(1)
    const sent = firstSent(captured)

    // Content is byte-identical — nothing was trimmed or marked
    expect(sent.attribute['gen_ai.input.messages']).toBe(huge)
    expect(sent.traceID).toBe('a'.repeat(32))
    expect(sent.spanID).toBe('b'.repeat(16))
    expect(sent.spanKind).toBe('chat')
    expect(sent.name).toBe('chat oversize')

    // The size risk is surfaced rather than silently resolved
    const log = logger.messages.join('\n')
    expect(log).toContain('above maxBatchBytes')
    expect(log).toContain('name=chat oversize')
    expect(log).not.toContain('trimmed')
  })

  it('keeps a normal span byte-identical', async () => {
    const flusher = new CLSFlusher(
      testResolvedConfig({ maxBatchBytes: 1024 * 1024, captureContent: true }),
      logger,
    )
    const captured = stubClient(flusher)

    flusher.enqueue(spanWithContent('chat small', 'a short prompt'))
    await flusher.flush()

    const sent = firstSent(captured)
    expect(sent.attribute['gen_ai.input.messages']).toBe('a short prompt')
    expect(logger.messages.join('\n')).not.toContain('trimmed')
  })

  it('splits a batch by byte budget without dropping spans', async () => {
    const limit = 8192
    const flusher = new CLSFlusher(
      testResolvedConfig({ maxBatchBytes: limit, batchMaxSize: 32, captureContent: true }),
      logger,
    )
    const captured = stubClient(flusher)

    // Each span is ~3 KB, so three of them cannot share one 8 KB batch
    for (let i = 0; i < 3; i++) {
      flusher.enqueue(spanWithContent(`chat ${i}`, 'y'.repeat(3000)))
    }
    await flusher.flush()

    const totalSent = captured.sent.reduce((n, b) => n + b.length, 0)
    expect(captured.sent.length).toBeGreaterThan(1)
    expect(totalSent).toBe(3)
    // Nothing was trimmed — these fit individually
    expect(logger.messages.join('\n')).not.toContain('trimmed')
  })

  it('reports identifying details when a send fails', async () => {
    const flusher = new CLSFlusher(testResolvedConfig(), logger)
    const internal = flusher as unknown as {
      client: unknown
      send(spans: CLSSpan[]): Promise<void>
    }
    internal.client = {}
    internal.send = (): Promise<void> => {
      const err = new Error('bad request') as Error & { code: number }
      err.code = 400
      return Promise.reject(err)
    }

    flusher.enqueue(spanWithContent('chat failing', 'payload'))
    await flusher.flush()

    const log = logger.messages.join('\n')
    expect(log).toContain('400')
    expect(log).toContain('kind=chat')
    expect(log).toContain('name=chat failing')
    expect(log).toContain(`trace=${'a'.repeat(32)}`)
  })

  it('distinguishes a local SDK size rejection from a network failure', async () => {
    const flusher = new CLSFlusher(testResolvedConfig(), logger)
    const internal = flusher as unknown as {
      client: unknown
      send(spans: CLSSpan[]): Promise<void>
    }
    internal.client = {}
    // The SDK checks size before sending and throws a plain Error with no
    // status code, so a naive handler would report it as an unknown failure.
    internal.send = (): Promise<void> => Promise.reject(
      new Error("InvalidLogSize. logItems' size exceeds maximum limitation : 19922944 bytes"),
    )

    flusher.enqueue(spanWithContent('chat too big', 'payload'))
    await flusher.flush()

    const log = logger.messages.join('\n')
    expect(log).toContain('rejected locally')
    expect(log).toContain('maxBatchBytes')
    expect(log).toContain('name=chat too big')
    // Must not be misfiled as a transient network problem
    expect(log).not.toContain('send failed (unknown)')
  })

  it('drains the final batch even when stop races an in-flight flush', async () => {
    const flusher = new CLSFlusher(testResolvedConfig({ batchMaxSize: 1 }), logger)
    const captured = stubClient(flusher)
    const internal = flusher as unknown as { send(spans: CLSSpan[]): Promise<void> }

    // Hold the first send open so a flush is still in flight when stop() runs.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const realSend = internal.send.bind(flusher)
    let first = true
    internal.send = async (spans: CLSSpan[]): Promise<void> => {
      if (first) {
        first = false
        await gate
      }
      await realSend(spans)
    }

    flusher.enqueue(spanWithContent('chat a', 'first'))
    flusher.enqueue(spanWithContent('chat b', 'second'))

    const inFlight = flusher.flush()
    const stopping = flusher.stop()
    release()
    await Promise.all([inFlight, stopping])

    // Both spans reached the transport; none were discarded by an early return.
    const names = captured.sent.flat().map(s => s.name).sort()
    expect(names).toEqual(['chat a', 'chat b'])
    expect(logger.messages.join('\n')).not.toContain('discarded after retries')
  })

  it('names the evicted span when the queue overflows', async () => {
    const flusher = new CLSFlusher(testResolvedConfig({ maxQueueSize: 2 }), logger)
    stubClient(flusher)
    // Prevent the size-triggered flush from draining the queue first
    const noFlush = vi.spyOn(flusher, 'flush').mockResolvedValue(undefined)

    flusher.enqueue(spanWithContent('chat oldest', 'first'))
    flusher.enqueue(spanWithContent('chat newer', 'second'))
    flusher.enqueue(spanWithContent('chat newest', 'third'))

    const log = logger.messages.join('\n')
    expect(log).toContain('queue full')
    expect(log).toContain('oldest: kind=chat name=chat oldest')
    noFlush.mockRestore()
  })
})
