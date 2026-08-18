import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshClsCoordinator } from '../src/coordinator.js'
import type { CLSSpan } from '../src/cls-types.js'
import {
  collect,
  event,
  llmOptions,
  logger,
  message,
  session,
  successfulStream,
  testResolvedConfig,
} from './helpers.js'

// Mock the CLS flusher to capture emitted spans without network I/O
vi.mock('../src/cls-flusher.js', () => {
  return {
    CLSFlusher: class MockCLSFlusher {
      start = vi.fn()
      stop = vi.fn().mockResolvedValue(undefined)
      enqueue = vi.fn()
      enqueueBatch = vi.fn()
      flush = vi.fn().mockResolvedValue(undefined)
    },
  }
})

function createCoordinator(overrides = {}) {
  const config = testResolvedConfig(overrides)
  const coordinator = new DshClsCoordinator(config, logger)
  coordinator.start()
  return coordinator
}

function getEnqueuedSpans(coordinator: DshClsCoordinator): CLSSpan[] {
  const flusher = (coordinator as unknown as { flusher: { enqueue: ReturnType<typeof vi.fn> } }).flusher
  return flusher.enqueue.mock.calls.map((call: unknown[]) => (call as [CLSSpan])[0])
}

afterEach(() => {
  vi.clearAllMocks()
  logger.messages.length = 0
})

describe('DshClsCoordinator', () => {
  it('exports ENTRY → AGENT → STEP → CHAT/TOOL spans for a complete turn', async () => {
    const coordinator = createCoordinator({ captureContent: true })
    const current = session()
    const started = Date.now() - 1_000
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 10))

    await collect(coordinator.interceptLlm(llmOptions(), successfulStream))

    coordinator.onSessionEvent(current, event(
      'tool/call',
      { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      4,
      Date.now(),
    ))
    coordinator.onSessionEvent(current, event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: message(
          'tool-1',
          'user',
          [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] }],
          { kind: 'tool', callId: 'call-1' },
        ),
      },
      5,
      Date.now(),
    ))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 6, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      7,
      Date.now(),
    ))

    const spans = getEnqueuedSpans(coordinator)
    // Should have: entry, chat, tool, step, agent
    expect(spans.length).toBeGreaterThanOrEqual(4)

    const byKind = new Map(spans.map(span => [span.spanKind, span]))
    const entry = byKind.get('entry')!
    const agent = byKind.get('agent')!
    const step = byKind.get('step')!
    const chat = byKind.get('chat')!
    const tool = byKind.get('tool')!

    expect(entry).toBeDefined()
    expect(agent).toBeDefined()
    expect(step).toBeDefined()
    expect(chat).toBeDefined()
    expect(tool).toBeDefined()

    // Verify trace hierarchy
    expect(agent.parentSpanID).toBe(entry.spanID)
    expect(step.parentSpanID).toBe(agent.spanID)
    expect(chat.parentSpanID).toBe(step.spanID)
    expect(tool.parentSpanID).toBe(step.spanID)

    // Same traceID for all spans in a turn
    const traceIds = new Set(spans.map(s => s.traceID))
    expect(traceIds.size).toBe(1)

    // Token usage on chat span
    expect(chat.attribute['gen_ai.usage.input_tokens']).toBe(10) // 8 + 2 cache read
    expect(chat.attribute['gen_ai.usage.output_tokens']).toBe(3)
    expect(chat.attribute['gen_ai.usage.cache_read.input_tokens']).toBe(2)

    // Content captured
    expect(chat.attribute['gen_ai.input.messages']).toContain('Hello from DSH')
    expect(tool.attribute['gen_ai.tool.call.arguments']).toContain('a.txt')
    expect(tool.attribute['gen_ai.tool.call.result']).toContain('file contents')

    // Agent token totals
    expect(agent.attribute['gen_ai.usage.input_tokens']).toBe(10)
    expect(agent.attribute['gen_ai.usage.output_tokens']).toBe(3)

    await coordinator.shutdown()
  })

  it('keeps content absent by default', async () => {
    const coordinator = createCoordinator() // captureContent defaults to false
    const current = session('privacy-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))
    await collect(coordinator.interceptLlm(llmOptions('privacy-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      3,
      Date.now(),
    ))

    const spans = getEnqueuedSpans(coordinator)
    const chat = spans.find(s => s.spanKind === 'chat')!
    expect(chat.attribute).not.toHaveProperty('gen_ai.input.messages')
    expect(chat.attribute).not.toHaveProperty('gen_ai.output.messages')

    await coordinator.shutdown()
  })

  it('creates a failed CHAT span when LLM stream errors', async () => {
    const coordinator = createCoordinator()
    const current = session('error-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))

    await collect(coordinator.interceptLlm(llmOptions('error-session'), () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } }
    })()))

    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } } },
      3,
      Date.now(),
    ))

    const spans = getEnqueuedSpans(coordinator)
    const chat = spans.find(s => s.spanKind === 'chat')!
    expect(chat.statusCode).toBe('ERROR')
    expect(chat.statusMessage).toContain('rate limited')

    await coordinator.shutdown()
  })

  it('does not replay historical events when adopting an existing session', async () => {
    const coordinator = createCoordinator()
    const current = {
      ...session('adopt-session'),
      events: [
        event('turn/start', { turn: 1 }, 0, Date.now() - 1_000),
        event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1, Date.now() - 900),
      ],
    }
    coordinator.adoptSession(current)

    const spans = getEnqueuedSpans(coordinator)
    expect(spans).toHaveLength(0)

    coordinator.closeAll()
    await coordinator.shutdown()
  })

  it('closes open spans on plugin unload', async () => {
    const coordinator = createCoordinator()
    const current = session('unload-session')
    const started = Date.now() - 500
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 10))

    coordinator.closeAll()

    const spans = getEnqueuedSpans(coordinator)
    // Should have emitted entry + step + agent (closed with error/interrupted)
    const agent = spans.find(s => s.spanKind === 'agent')
    expect(agent).toBeDefined()
    expect(agent!.statusCode).toBe('ERROR')

    await coordinator.shutdown()
  })
})
