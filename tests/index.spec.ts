import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshGenerateOptions, DshSession, DshSessionEvent, DshStreamChunk } from '../src/dsh-types.js'
import { apply } from '../src/index.js'
import { llmOptions, session, successfulStream, testConfig } from './helpers.js'

const mocks = vi.hoisted(() => {
  const coordinator = {
    start: vi.fn(),
    adoptSession: vi.fn(),
    disposeSession: vi.fn(),
    onSessionEvent: vi.fn(),
    interceptLlm: vi.fn(),
    closeAll: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  }
  return {
    coordinator,
    DshClsCoordinator: vi.fn(function MockDshClsCoordinator() {
      return coordinator
    }),
  }
})

vi.mock('../src/coordinator.js', () => ({
  DshClsCoordinator: mocks.DshClsCoordinator,
}))

type Listener = (...args: never[]) => unknown

function testContext(existing: DshSession[] = []) {
  const listeners = new Map<string, Listener>()
  const disposeOrder: string[] = []
  let cleanup: (() => void | Promise<void>) | undefined
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const context = {
    sessions: { list: vi.fn(() => existing) },
    logger,
    on: vi.fn((eventName: string, listener: Listener) => {
      listeners.set(eventName, listener)
      return vi.fn(() => disposeOrder.push(eventName))
    }),
    effect: vi.fn((factory: () => () => void | Promise<void>) => {
      cleanup = factory()
    }),
  }
  return {
    context: context as unknown as Context,
    disposeOrder,
    listeners,
    logger,
    runCleanup: async () => cleanup?.(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(mocks.coordinator)) mock.mockReset()
  mocks.coordinator.shutdown.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('plugin lifecycle', () => {
  it('does not create coordinator when collection is disabled', () => {
    const { context, logger } = testContext([session('existing')])

    apply(context, testConfig({ enabled: false }))

    expect(mocks.DshClsCoordinator).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('[cls-dsh] collection is disabled')
  })

  it('warns and does not start when CLS config is incomplete', () => {
    const { context, logger } = testContext()

    apply(context, testConfig({
      endpoint: '',
      topicId: '',
      secretId: '',
      secretKey: '',
    }))

    expect(mocks.DshClsCoordinator).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing: CLS_ENDPOINT'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('export CLS_ENDPOINT'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cordis.patch.yml'))
  })

  it('wires DSH events and shuts down in order', async () => {
    const existing = session('existing')
    const created = session('created')
    const { context, disposeOrder, listeners, logger, runCleanup } = testContext([existing])

    apply(context, testConfig())

    expect(mocks.DshClsCoordinator).toHaveBeenCalled()
    expect(mocks.coordinator.start).toHaveBeenCalled()
    expect(mocks.coordinator.adoptSession).toHaveBeenCalledWith(existing)

    const createdListener = listeners.get('session/created') as (value: DshSession) => void
    const eventListener = listeners.get('session/event') as (
      value: DshSession,
      event: DshSessionEvent,
    ) => void
    const disposedListener = listeners.get('session/disposed') as (value: DshSession) => void
    const streamListener = listeners.get('llm/stream') as (
      options: DshGenerateOptions,
      next: () => AsyncIterable<DshStreamChunk>,
    ) => AsyncIterable<DshStreamChunk>

    const observedEvent = { type: 'turn/start', data: { turn: 1 }, seq: 0, time: Date.now() }
    const options = llmOptions('created')
    const downstream = successfulStream()
    const observed = successfulStream()
    mocks.coordinator.interceptLlm.mockReturnValue(observed)

    createdListener(created)
    eventListener(created, observedEvent)
    disposedListener(created)
    const stream = streamListener(options, () => downstream)

    expect(mocks.coordinator.adoptSession).toHaveBeenCalledWith(created)
    expect(mocks.coordinator.onSessionEvent).toHaveBeenCalledWith(created, observedEvent)
    expect(mocks.coordinator.disposeSession).toHaveBeenCalledWith(created)
    expect(mocks.coordinator.interceptLlm).toHaveBeenCalledWith(options, expect.any(Function))
    expect(stream).toBe(observed)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[cls-dsh] loaded'))

    await runCleanup()

    expect(disposeOrder).toEqual([
      'llm/stream',
      'session/disposed',
      'session/event',
      'session/created',
    ])
    expect(mocks.coordinator.closeAll).toHaveBeenCalledOnce()
    expect(mocks.coordinator.shutdown).toHaveBeenCalledOnce()
  })

  it('isolates session and close failures while still shutting down', async () => {
    const { context, listeners, logger, runCleanup } = testContext()
    apply(context, testConfig())
    const current = session('failure')
    mocks.coordinator.adoptSession.mockImplementationOnce(() => {
      throw new Error('adopt failed')
    })
    mocks.coordinator.disposeSession.mockImplementationOnce(() => {
      throw new Error('dispose failed')
    })
    mocks.coordinator.closeAll.mockImplementationOnce(() => {
      throw new Error('close failed')
    })

    const createdListener = listeners.get('session/created') as (value: DshSession) => void
    const disposedListener = listeners.get('session/disposed') as (value: DshSession) => void
    createdListener(current)
    disposedListener(current)
    await runCleanup()

    expect(logger.warn).toHaveBeenCalledWith(
      '[cls-dsh] failed to adopt session failure: Error: adopt failed',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      '[cls-dsh] failed to dispose session failure: Error: dispose failed',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      '[cls-dsh] failed to close live spans: Error: close failed',
    )
    expect(mocks.coordinator.shutdown).toHaveBeenCalledOnce()
  })
})
