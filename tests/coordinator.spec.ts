import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshClsCoordinator } from '../src/coordinator.js'
import type { CLSSpan } from '../src/cls-types.js'
import type { DshMessage } from '../src/dsh-types.js'
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
    coordinator.onSessionEvent(current, event(
      'user/message',
      message('user-1', 'user', [{ type: 'text', text: 'Hello from DSH' }], { kind: 'user' }),
      1,
      started + 5,
    ))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 2, started + 10))

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

  it('keeps injected context out of ENTRY and AGENT but in the CHAT request', async () => {
    const coordinator = createCoordinator({ captureContent: true })
    const current = session('inject-session')
    const started = Date.now() - 200
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))

    // DSH emits synthetic model-visible context as user/message too — only
    // source.kind distinguishes it from the human's own request.
    const injected: Array<[string, DshMessage['source'], string]> = [
      ['user-direct', { kind: 'user' }, 'direct user prompt'],
      ['runtime-context', { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot' }, 'injected runtime context'],
      ['skill-catalog', { kind: 'skill-catalog', form: 'catalog' }, 'injected skill catalog'],
      ['goal-round', { kind: 'goal', goalId: 'goal-1', round: 1 }, 'automatic goal continuation'],
      ['coordinator-relay', { kind: 'coordinator', form: 'relay' }, 'coordinator follow-up'],
      ['user-steering', { kind: 'user', rpcId: 'rpc-1' }, 'direct user steering'],
    ]
    injected.forEach(([id, source, text], index) => {
      coordinator.onSessionEvent(current, event(
        'user/message',
        message(id, 'user', [{ type: 'text', text }], source),
        index + 1,
        started + index + 1,
      ))
    })

    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 7, started + 10))
    await collect(coordinator.interceptLlm(llmOptions('inject-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 8, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      9,
      Date.now(),
    ))

    const spans = getEnqueuedSpans(coordinator)
    const entry = spans.find(s => s.spanKind === 'entry')!
    const agent = spans.find(s => s.spanKind === 'agent')!
    const chat = spans.find(s => s.spanKind === 'chat')!

    // ENTRY/AGENT expose only the two direct user inputs
    for (const span of [entry, agent]) {
      const inputs = JSON.parse(span.attribute['gen_ai.input.messages'] as string)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs)).toContain('direct user prompt')
      expect(JSON.stringify(inputs)).toContain('direct user steering')
      expect(JSON.stringify(inputs)).not.toContain('injected runtime context')
      expect(JSON.stringify(inputs)).not.toContain('injected skill catalog')
    }

    // CHAT retains the full model-visible request for this turn
    const chatInputs = JSON.parse(chat.attribute['gen_ai.input.messages'] as string)
    expect(chatInputs).toHaveLength(6)
    const chatRaw = chat.attribute['gen_ai.input.messages'] as string
    expect(chatRaw).toContain('injected runtime context')
    expect(chatRaw).toContain('injected skill catalog')
    expect(chatRaw).toContain('automatic goal continuation')
    expect(chatRaw).toContain('coordinator follow-up')

    await coordinator.shutdown()
  })

  it('scopes CHAT input to the current turn and keeps same-turn tool context', async () => {
    const coordinator = createCoordinator({ captureContent: true })
    const current = session('scope-session')
    const base = Date.now() - 500

    coordinator.adoptSession(current)

    // ── Turn 1 ──
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, base))
    coordinator.onSessionEvent(current, event(
      'user/message',
      message('u1', 'user', [{ type: 'text', text: 'first turn question' }], { kind: 'user' }),
      1,
      base + 1,
    ))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 2, base + 2))
    await collect(coordinator.interceptLlm(llmOptions('scope-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 3, base + 3))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      4,
      base + 4,
    ))

    // ── Turn 2: a tool loop across two steps ──
    coordinator.onSessionEvent(current, event('turn/start', { turn: 2 }, 5, base + 10))
    coordinator.onSessionEvent(current, event(
      'user/message',
      message('u2', 'user', [{ type: 'text', text: 'second turn question' }], { kind: 'user' }),
      6,
      base + 11,
    ))
    coordinator.onSessionEvent(current, event('step/start', { turn: 2, step: 1 }, 7, base + 12))
    await collect(coordinator.interceptLlm(llmOptions('scope-session'), successfulStream))
    coordinator.onSessionEvent(current, event(
      'assistant/message',
      {
        turn: 2,
        step: 1,
        message: message(
          'a1',
          'assistant',
          [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"b.txt"}' }],
          { kind: 'assistant' },
        ),
      },
      8,
      base + 13,
    ))
    coordinator.onSessionEvent(current, event(
      'tool/result',
      {
        turn: 2,
        step: 1,
        message: message(
          't1',
          'user',
          [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'tool payload' }] }],
          { kind: 'tool', callId: 'c1' },
        ),
      },
      9,
      base + 14,
    ))
    coordinator.onSessionEvent(current, event('step/end', { turn: 2, step: 1 }, 10, base + 15))

    // Second step of the same turn — its CHAT span must retain the tool context
    coordinator.onSessionEvent(current, event('step/start', { turn: 2, step: 2 }, 11, base + 16))
    await collect(coordinator.interceptLlm(llmOptions('scope-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 2, step: 2 }, 12, base + 17))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 2, reason: { kind: 'completed' } },
      13,
      base + 18,
    ))

    const chats = getEnqueuedSpans(coordinator).filter(s => s.spanKind === 'chat')
    expect(chats).toHaveLength(3)
    const [turn1Chat, turn2Step1Chat, turn2Step2Chat] = chats as [CLSSpan, CLSSpan, CLSSpan]

    // Each trace covers one turn — turn 2 never repeats turn 1's history
    const turn1Raw = turn1Chat.attribute['gen_ai.input.messages'] as string
    expect(turn1Raw).toContain('first turn question')

    const step1Raw = turn2Step1Chat.attribute['gen_ai.input.messages'] as string
    expect(step1Raw).toContain('second turn question')
    expect(step1Raw).not.toContain('first turn question')

    // Same-turn tool loop context survives into the next step
    const step2Raw = turn2Step2Chat.attribute['gen_ai.input.messages'] as string
    expect(step2Raw).toContain('second turn question')
    expect(step2Raw).toContain('tool payload')
    expect(step2Raw).not.toContain('first turn question')

    // Distinct traces per turn
    expect(turn1Chat.traceID).not.toBe(turn2Step1Chat.traceID)
    expect(turn2Step1Chat.traceID).toBe(turn2Step2Chat.traceID)

    await coordinator.shutdown()
  })

  it('reports only the final answer on ENTRY and AGENT', async () => {
    const coordinator = createCoordinator({ captureContent: true })
    const current = session('final-output-session')
    const started = Date.now() - 300
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event(
      'user/message',
      message('u1', 'user', [{ type: 'text', text: 'do the thing' }], { kind: 'user' }),
      1,
      started + 1,
    ))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 2, started + 2))

    // Intermediate tool-call message, then the terminal answer
    coordinator.onSessionEvent(current, event(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: message(
          'a-tool',
          'assistant',
          [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
          { kind: 'assistant' },
        ),
      },
      3,
      started + 3,
    ))
    coordinator.onSessionEvent(current, event(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: message(
          'a-final',
          'assistant',
          [{ type: 'text', text: 'the final answer' }],
          { kind: 'assistant' },
        ),
      },
      4,
      started + 4,
    ))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 5, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      6,
      Date.now(),
    ))

    const spans = getEnqueuedSpans(coordinator)
    for (const kind of ['entry', 'agent']) {
      const span = spans.find(s => s.spanKind === kind)!
      const outputs = JSON.parse(span.attribute['gen_ai.output.messages'] as string)
      expect(outputs).toHaveLength(1)
      expect(JSON.stringify(outputs)).toContain('the final answer')
      expect(JSON.stringify(outputs)).not.toContain('read_file')
    }

    await coordinator.shutdown()
  })
})
