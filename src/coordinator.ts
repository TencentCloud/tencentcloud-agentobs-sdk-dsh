/**
 * DSH → CLS Trace Coordinator
 *
 * Converts DSH session/event lifecycle and LLM streams into CLS-formatted spans.
 * Span hierarchy: entry → agent → step → chat/tool
 */

import type { CLSSpan, CLSSpanAttributes } from './cls-types.js'
import { createCLSSpan } from './cls-types.js'
import { CLSFlusher } from './cls-flusher.js'
import type { ResolvedClsConfig } from './config.js'
import type {
  DshContentBlock,
  DshFailure,
  DshGenerateOptions,
  DshLogger,
  DshMessage,
  DshSession,
  DshSessionEvent,
  DshStreamChunk,
  DshTokenUsage,
  DshToolSchema,
  DshTurnReason,
} from './dsh-types.js'
import {
  durationMs,
  durationNanoStr,
  getLocalIp,
  msToNanoStr,
  newSpanId,
  newTraceId,
  safeStringify,
} from './utils.js'
import { VERSION } from './version.js'

// ── Internal state types ──────────────────────────────────────────────────

interface ToolState {
  spanId: string
  name: string
  callId: string
  arguments: string
  startTime: number
  ended: boolean
}

interface LlmState {
  spanId: string
  attempt: number
  options: DshGenerateOptions
  blocks: Array<{ type: string } & Record<string, unknown>>
  usage?: DshTokenUsage
  startTime: number
  startMono: number
  ended: boolean
  firstTokenSeen: boolean
  firstTokenMono?: number
}

interface StepState {
  turn: number
  step: number
  spanId: string
  startTime: number
  tools: Map<string, ToolState>
  llms: Set<LlmState>
  nextAttempt: number
  lastFinishReason?: string
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface InputMessage {
  role: string
  parts: unknown[]
}

interface OutputMessage {
  role: string
  parts: unknown[]
  finishReason: string
}

interface TurnState {
  turn: number
  traceID: string
  entrySpanId: string
  agentSpanId: string
  step: StepState | undefined
  startTime: number
  model?: string
  provider?: string
  usage: UsageTotals
  inputs: InputMessage[]
  outputs: OutputMessage[]
}

interface SessionState {
  session: DshSession
  sessionId: string
  turn: TurnState | undefined
}

// ── Helpers ──────────────────────────────────────────────────────────────

function eventData<T>(event: DshSessionEvent): T {
  return event.data as T
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'cancelled'
    case 'stop':
    case 'error':
      return reason
    default:
      return reason ?? 'unknown'
  }
}

function finishFailure(reason: DshTurnReason): DshFailure | undefined {
  if (reason.kind === 'error') {
    const value = (reason as { error?: DshFailure }).error
    return value ?? { message: 'DSH turn ended with an error', code: 'ERROR' }
  }
  if (reason.kind === 'aborted') return { message: 'DSH turn was aborted', code: 'ABORTED' }
  if (reason.kind === 'interrupted') return { message: 'DSH turn was interrupted', code: 'INTERRUPTED' }
  return undefined
}

function usageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addUsage(total: UsageTotals, usage: DshTokenUsage): void {
  total.inputTokens += usage.inputTokens
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += usage.cacheReadTokens ?? 0
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

function isVisibleToken(chunk: DshStreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof (chunk as { text?: unknown }).text === 'string'
      && (chunk as { text: string }).text !== ''
  }
  if (chunk.type !== 'tool-call-delta') return false
  const value = chunk as { argumentsDelta?: unknown; name?: unknown }
  return value.name !== undefined
    || (typeof value.argumentsDelta === 'string' && value.argumentsDelta !== '')
}

function mapContentBlock(block: DshContentBlock): unknown {
  const value = block as Record<string, unknown>
  switch (block.type) {
    case 'text':
      return { type: 'text', content: value.text ?? '' }
    case 'reasoning':
      return { type: 'reasoning', content: value.text ?? '' }
    case 'tool-call':
      return {
        type: 'tool_call',
        id: value.id ?? null,
        name: value.name ?? '',
        arguments: parseToolArguments(typeof value.arguments === 'string' ? value.arguments : ''),
      }
    case 'tool-result': {
      const nested = Array.isArray(value.content)
        ? (value.content as DshContentBlock[]).map(mapContentBlock)
        : []
      return {
        type: 'tool_call_response',
        id: typeof value.toolCallId === 'string' ? value.toolCallId : null,
        response: nested,
      }
    }
    case 'image': {
      const attachment = value.attachment !== null && typeof value.attachment === 'object'
        ? value.attachment as Record<string, unknown>
        : {}
      return {
        type: 'image',
        attachment_id: attachment.attachmentId,
        mime_type: attachment.mediaType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      }
    }
    default:
      return value
  }
}

function mapContent(blocks: readonly DshContentBlock[]): unknown[] {
  return blocks.map(mapContentBlock)
}

function parseToolArguments(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

function mapInputMessages(messages: readonly DshMessage[]): InputMessage[] {
  return messages.map(msg => ({
    role: msg.source.kind === 'tool' ? 'tool' : msg.role,
    parts: mapContent(msg.content),
  }))
}

function mapInputMessage(message: DshMessage): InputMessage {
  return {
    role: message.source.kind === 'tool' ? 'tool' : message.role,
    parts: mapContent(message.content),
  }
}

function mapOutputMessage(
  blocks: readonly DshContentBlock[],
  finishReason: string,
): OutputMessage {
  return { role: 'assistant', parts: mapContent(blocks), finishReason }
}

function mapOutputMessageFromDsh(
  message: DshMessage,
  finishReason: string,
): OutputMessage {
  return { role: message.role, parts: mapContent(message.content), finishReason }
}

function mapSystemInstruction(system: string | undefined): unknown[] {
  return system === undefined || system === '' ? [] : [{ type: 'text', content: system }]
}

function mapToolDefinitions(tools: readonly DshToolSchema[] | undefined): unknown[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || null,
    parameters: tool.parameters,
  }))
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars) + '...[truncated]'
}

// ── Coordinator ──────────────────────────────────────────────────────────

export class DshClsCoordinator {
  private readonly sessions = new Map<string, SessionState>()
  private readonly flusher: CLSFlusher
  private readonly config: ResolvedClsConfig
  private readonly logger: DshLogger
  private readonly hostname: string
  private readonly serviceInstanceId: string

  constructor(config: ResolvedClsConfig, logger: DshLogger) {
    this.config = config
    this.logger = logger
    this.hostname = getLocalIp()
    this.serviceInstanceId = `${config.serviceName}@${this.hostname}:${process.pid}`
    this.flusher = new CLSFlusher(config, logger)
  }

  start(): void {
    this.flusher.start()
  }

  async shutdown(): Promise<void> {
    await this.flusher.stop()
  }

  adoptSession(session: DshSession): void {
    const id = String(session.id)
    const previous = this.sessions.get(id)
    if (previous?.session === session) return
    if (previous?.turn !== undefined) {
      this.closeTurn(previous, { kind: 'interrupted' }, Date.now())
    }
    this.sessions.set(id, { session, sessionId: id, turn: undefined })
    this.debug(`adopted session ${id}`)
  }

  disposeSession(session: DshSession): void {
    const state = this.sessions.get(String(session.id))
    if (state === undefined || state.session !== session) return
    if (state.turn !== undefined) this.closeTurn(state, { kind: 'interrupted' }, Date.now())
    this.sessions.delete(String(session.id))
    this.debug(`disposed session ${String(session.id)}`)
  }

  onSessionEvent(session: DshSession, event: DshSessionEvent): void {
    try {
      const state = this.ensureSession(session)
      switch (event.type) {
        case 'turn/start':
          this.startTurn(state, eventData<{ turn: number }>(event).turn, event.time)
          break
        case 'turn/end': {
          const data = eventData<{ turn: number; reason: DshTurnReason }>(event)
          if (state.turn?.turn === data.turn) this.closeTurn(state, data.reason, event.time)
          break
        }
        case 'step/start': {
          const data = eventData<{ turn: number; step: number }>(event)
          this.startStep(state, data.turn, data.step, event.time)
          break
        }
        case 'step/end': {
          const data = eventData<{ turn: number; step: number }>(event)
          const step = state.turn?.step
          if (step?.turn === data.turn && step.step === data.step) {
            this.closeStep(state.turn!, event.time)
          }
          break
        }
        case 'tool/call': {
          const data = eventData<{
            turn: number; step: number; callId: string; name: string; arguments: string
          }>(event)
          this.startTool(state, data, event.time)
          break
        }
        case 'tool/result': {
          const data = eventData<{
            turn: number; step: number; message: DshMessage; error?: { name: string; code: string }
          }>(event)
          this.endTool(state, data, event.time)
          break
        }
        case 'user/message':
          this.captureTurnInput(state, eventData<DshMessage>(event))
          break
        case 'assistant/message': {
          const data = eventData<{ turn: number; step: number; message: DshMessage }>(event)
          this.captureTurnOutput(state, data.turn, data.step, data.message)
          break
        }
      }
    } catch (error: unknown) {
      this.warn(`failed to observe ${event.type} for session ${String(session.id)}: ${String(error)}`)
    }
  }

  interceptLlm(
    options: DshGenerateOptions,
    next: () => AsyncIterable<DshStreamChunk>,
  ): AsyncIterable<DshStreamChunk> {
    if (options.sessionId === undefined || options.purpose !== undefined) return next()

    let llm: LlmState | undefined
    try {
      llm = this.startLlm(options)
    } catch (error: unknown) {
      this.warn(`failed to start LLM telemetry for session ${options.sessionId}: ${String(error)}`)
    }

    let stream: AsyncIterable<DshStreamChunk>
    try {
      stream = next()
    } catch (error: unknown) {
      if (llm !== undefined) this.failLlm(llm, error, Date.now())
      throw error
    }
    return llm === undefined ? stream : this.observeLlmStream(llm, stream)
  }

  closeAll(reason = 'plugin unloaded'): void {
    const now = Date.now()
    for (const state of this.sessions.values()) {
      if (state.turn !== undefined) {
        this.closeTurn(state, {
          kind: 'error',
          error: { message: reason, code: 'PLUGIN_UNLOADED' },
        }, now)
      }
    }
    this.sessions.clear()
  }

  // ── Private methods ──────────────────────────────────────────────────

  private ensureSession(session: DshSession): SessionState {
    const id = String(session.id)
    const existing = this.sessions.get(id)
    if (existing?.session === session) return existing
    this.adoptSession(session)
    return this.sessions.get(id)!
  }

  private startTurn(state: SessionState, turn: number, startTime: number): void {
    if (state.turn !== undefined) {
      this.closeTurn(state, { kind: 'interrupted' }, startTime)
    }
    const traceID = newTraceId()
    const entrySpanId = newSpanId()
    const agentSpanId = newSpanId()

    state.turn = {
      turn,
      traceID,
      entrySpanId,
      agentSpanId,
      step: undefined,
      startTime,
      usage: usageTotals(),
      inputs: [],
      outputs: [],
    }

    // Entry and agent spans are emitted at turn close when we have full stats

    this.debug(`started turn ${state.sessionId}:${turn}`)
  }

  private startStep(state: SessionState, turn: number, step: number, startTime: number): void {
    const active = state.turn
    if (active === undefined || active.turn !== turn) return
    if (active.step !== undefined) this.closeStep(active, startTime)

    active.step = {
      turn,
      step,
      spanId: newSpanId(),
      startTime,
      tools: new Map(),
      llms: new Set(),
      nextAttempt: 1,
    }
  }

  private startLlm(options: DshGenerateOptions): LlmState | undefined {
    const session = this.sessions.get(String(options.sessionId))
    const turn = session?.turn
    const step = turn?.step
    if (session === undefined || turn === undefined || step === undefined) return undefined

    const attempt = step.nextAttempt++
    const llm: LlmState = {
      spanId: newSpanId(),
      attempt,
      options,
      blocks: [],
      startTime: Date.now(),
      startMono: performance.now(),
      ended: false,
      firstTokenSeen: false,
    }
    step.llms.add(llm)
    turn.model = options.model
    turn.provider = options.provider
    this.debug(`started LLM attempt ${attempt} for session ${String(options.sessionId)} using ${options.provider}/${options.model}`)
    return llm
  }

  private async *observeLlmStream(
    state: LlmState,
    stream: AsyncIterable<DshStreamChunk>,
  ): AsyncIterable<DshStreamChunk> {
    try {
      for await (const chunk of stream) {
        try {
          this.observeLlmChunk(state, chunk)
        } catch (error: unknown) {
          this.warn(`failed to process an LLM chunk: ${String(error)}`)
        }
        yield chunk
      }
      if (!state.ended) {
        this.failLlm(state, new Error('LLM stream ended without a finish chunk'), Date.now())
      }
    } catch (error: unknown) {
      if (!state.ended) this.failLlm(state, error, Date.now())
      throw error
    } finally {
      if (!state.ended) {
        const aborted = state.options.signal?.aborted === true
        this.failLlm(
          state,
          new Error(aborted ? 'LLM stream was aborted' : 'LLM stream consumer stopped early'),
          Date.now(),
        )
      }
    }
  }

  private observeLlmChunk(state: LlmState, chunk: DshStreamChunk): void {
    if (state.ended) return
    if (!state.firstTokenSeen && isVisibleToken(chunk)) {
      state.firstTokenSeen = true
      state.firstTokenMono = performance.now()
    }
    if (chunk.type === 'block-end') {
      const block = (chunk as { block: { type: string } & Record<string, unknown> }).block
      state.blocks.push(block)
      return
    }
    if (chunk.type === 'usage') {
      state.usage = (chunk as { usage: DshTokenUsage }).usage
      return
    }
    if (chunk.type !== 'finish') return
    const reason = (chunk as { reason: { kind: string; failure?: DshFailure } }).reason
    this.finishLlm(state, reason, Date.now())
  }

  private finishLlm(
    state: LlmState,
    reason: { kind: string; failure?: DshFailure },
    endTime: number,
  ): void {
    if (state.ended) return
    state.ended = true
    const finishReason = mapFinishReason(reason.kind)
    const session = this.sessions.get(String(state.options.sessionId))
    const turn = session?.turn
    const step = turn?.step

    if (turn !== undefined && state.usage !== undefined) {
      addUsage(turn.usage, state.usage)
    }
    if (step !== undefined) {
      step.lastFinishReason = finishReason
    }

    const isError = reason.kind === 'error' || reason.kind === 'aborted'
    const chatSpan = this.buildChatSpan(state, session!, endTime, finishReason, isError, reason.failure)
    this.flusher.enqueue(chatSpan)
  }

  private failLlm(state: LlmState, error: unknown, endTime: number): void {
    if (state.ended) return
    state.ended = true
    const aborted = state.options.signal?.aborted === true
    const finishReason = aborted ? 'cancelled' : 'error'

    const session = this.sessions.get(String(state.options.sessionId))
    const turn = session?.turn
    const step = turn?.step

    if (turn !== undefined && state.usage !== undefined) {
      addUsage(turn.usage, state.usage)
    }
    if (step !== undefined) {
      step.lastFinishReason = finishReason
    }

    if (session) {
      const chatSpan = this.buildChatSpan(state, session, endTime, finishReason, true, {
        message: error instanceof Error ? error.message : String(error),
        code: aborted ? 'ABORTED' : 'ERROR',
      })
      this.flusher.enqueue(chatSpan)
    }
  }

  private startTool(
    state: SessionState,
    data: { turn: number; step: number; callId: string; name: string; arguments: string },
    startTime: number,
  ): void {
    const turn = state.turn
    const step = turn?.step
    if (turn?.turn !== data.turn || step?.step !== data.step) return

    // Fail previous tool with same callId (duplicate protection)
    const previous = step.tools.get(data.callId)
    if (previous !== undefined && !previous.ended) {
      previous.ended = true
      const failedSpan = this.buildToolSpan(state, previous, startTime, [], true, {
        name: `duplicate tool call id ${data.callId}`,
        code: 'DUPLICATE_CALL_ID',
      })
      this.flusher.enqueue(failedSpan)
    }

    const tool: ToolState = {
      spanId: newSpanId(),
      name: data.name,
      callId: data.callId,
      arguments: data.arguments,
      startTime,
      ended: false,
    }
    step.tools.set(data.callId, tool)
  }

  private endTool(
    state: SessionState,
    data: { turn: number; step: number; message: DshMessage; error?: { name: string; code: string } },
    endTime: number,
  ): void {
    const step = state.turn?.step
    if (state.turn?.turn !== data.turn || step?.step !== data.step) return
    const callId = typeof data.message.source.callId === 'string'
      ? data.message.source.callId
      : undefined
    if (callId === undefined) return
    const tool = step.tools.get(callId)
    if (tool === undefined || tool.ended) return
    tool.ended = true

    const resultBlock = data.message.content.find(b => b.type === 'tool-result')
    const result = resultBlock?.type === 'tool-result'
      ? mapContent((resultBlock as { content: DshContentBlock[] }).content)
      : mapContent(data.message.content)

    const isError = data.error !== undefined
      || (resultBlock?.type === 'tool-result'
        && (resultBlock as { isError?: boolean }).isError === true)

    const toolSpan = this.buildToolSpan(state, tool, endTime, result, isError, data.error)
    this.flusher.enqueue(toolSpan)
  }

  private closeStep(turn: TurnState, endTime: number, forcedReason?: string): void {
    const step = turn.step
    if (step === undefined) return

    // Fail any unclosed LLMs
    for (const llm of step.llms) {
      if (!llm.ended) this.failLlm(llm, new Error('DSH step ended before the LLM stream'), endTime)
    }
    // Fail any unclosed tools
    for (const tool of step.tools.values()) {
      if (!tool.ended) {
        tool.ended = true
        const sessionState = [...this.sessions.values()].find(s => s.turn?.step === step)
        if (sessionState) {
          const failedSpan = this.buildToolSpan(sessionState, tool, endTime, [], true, {
            name: 'DSH step ended before the tool result',
            code: 'STEP_ENDED',
          })
          this.flusher.enqueue(failedSpan)
        }
      }
    }

    const finishReason = forcedReason ?? step.lastFinishReason ?? 'completed'
    const stepSpan = this.buildStepSpan(turn, step, endTime, finishReason)
    this.flusher.enqueue(stepSpan)
    turn.step = undefined
  }

  private captureTurnInput(state: SessionState, message: DshMessage): void {
    if (state.turn === undefined) return
    state.turn.inputs.push(mapInputMessage(message))
  }

  private captureTurnOutput(state: SessionState, turn: number, step: number, message: DshMessage): void {
    const active = state.turn
    if (active?.turn !== turn) return
    const finish = active.step?.step === step
      ? active.step.lastFinishReason ?? 'unknown'
      : 'unknown'
    active.outputs.push(mapOutputMessageFromDsh(message, finish))
  }

  private closeTurn(state: SessionState, reason: DshTurnReason, endTime: number): void {
    const turn = state.turn
    if (turn === undefined) return
    if (turn.step !== undefined) this.closeStep(turn, endTime, 'interrupted')

    const finishReason = mapFinishReason(reason.kind)
    const failure = finishFailure(reason)

    // Emit agent span with final stats
    const agentSpan = this.buildAgentSpanEnd(state, turn, endTime, finishReason, failure)
    this.flusher.enqueue(agentSpan)

    // Emit entry span (closed — now has end time and conversation content)
    const entrySpan = this.buildEntrySpanEnd(state, turn, endTime, finishReason, failure)
    this.flusher.enqueue(entrySpan)

    this.debug(`closed turn ${state.sessionId}:${turn.turn} with reason ${reason.kind}`)
    state.turn = undefined
  }

  // ── Span builders ──────────────────────────────────────────────────────

  private commonAttributes(state: SessionState): CLSSpanAttributes {
    const session = state.session
    const turn = state.turn
    return {
      'gen_ai.agent.system': 'deepseek-harness',
      'gen_ai.session.id': state.sessionId,
      'gen_ai.turn.id': turn ? `${state.sessionId}:t${turn.turn}` : '',
      'dsh.session.id': state.sessionId,
      'dsh.turn': turn ? turn.turn : 0,
      'service.name': this.config.serviceName,
      'service.instance.id': this.serviceInstanceId,
      'telemetry.sdk.name': 'tencentcloud-agentobs-sdk-dsh',
      'telemetry.sdk.language': 'javascript',
      'telemetry.sdk.version': VERSION,
      ...(session.header.cwd ? { 'dsh.session.cwd': session.header.cwd } : {}),
      ...(session.header.parentSession ? { 'dsh.session.parent_id': String(session.header.parentSession) } : {}),
      ...(session.header.origin ? { 'dsh.session.origin': session.header.origin } : {}),
      ...(session.header.delegationDepth !== undefined ? { 'dsh.session.delegation_depth': session.header.delegationDepth } : {}),
      ...(session.header.agentPreset ? { 'dsh.agent.preset': session.header.agentPreset } : {}),
      'gen_ai.agent.name': session.header.agentPreset || 'deepseek-harness',
      ...this.config.resourceAttributes,
    }
  }

  private buildEntrySpanEnd(
    state: SessionState,
    turn: TurnState,
    endTime: number,
    finishReason: string,
    failure: DshFailure | undefined,
  ): CLSSpan {
    const span = createCLSSpan()
    span.spanKind = 'entry'
    span.traceID = turn.traceID
    span.spanID = turn.entrySpanId
    span.parentSpanID = ''
    span.sessionID = state.sessionId
    span.name = 'enter_application'
    span.kind = 'SERVER'
    span.statusCode = failure ? 'ERROR' : 'OK'
    span.statusMessage = failure?.message ?? ''
    span.start = msToNanoStr(turn.startTime)
    span.end = msToNanoStr(endTime)
    span.duration = durationNanoStr(turn.startTime, endTime)
    span.durationMs = String(durationMs(turn.startTime, endTime))
    span.host = this.hostname
    span.service = this.config.serviceName

    const attrs: CLSSpanAttributes = {
      ...this.commonAttributes(state),
      'gen_ai.span.kind': 'entry',
      'gen_ai.operation.name': 'enter_application',
      'gen_ai.entry.type': 'cli',
      'dsh.turn.end_reason': finishReason,
    }

    // Conversation-level content capture (same as agent)
    if (this.config.captureContent && (turn.inputs.length > 0 || turn.outputs.length > 0)) {
      attrs['gen_ai.input.messages'] = truncate(safeStringify(turn.inputs), this.config.contentMaxChars)
      attrs['gen_ai.output.messages'] = truncate(
        safeStringify(turn.outputs.map(m => ({ role: m.role, parts: m.parts, finish_reason: m.finishReason }))),
        this.config.contentMaxChars,
      )
    }

    span.attribute = attrs
    return span
  }

  private buildAgentSpanEnd(
    state: SessionState,
    turn: TurnState,
    endTime: number,
    finishReason: string,
    failure: DshFailure | undefined,
  ): CLSSpan {
    const agentName = state.session.header.agentPreset || 'deepseek-harness'
    const span = createCLSSpan()
    span.spanKind = 'agent'
    span.traceID = turn.traceID
    span.spanID = turn.agentSpanId
    span.parentSpanID = turn.entrySpanId
    span.sessionID = state.sessionId
    span.agentID = turn.agentSpanId
    span.name = `invoke_agent ${agentName}`
    span.kind = 'INTERNAL'
    span.statusCode = failure ? 'ERROR' : 'OK'
    span.statusMessage = failure?.message ?? ''
    span.start = msToNanoStr(turn.startTime)
    span.end = msToNanoStr(endTime)
    span.duration = durationNanoStr(turn.startTime, endTime)
    span.durationMs = String(durationMs(turn.startTime, endTime))
    span.host = this.hostname
    span.service = this.config.serviceName

    const totalInput = turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheWriteTokens
    const totalTokens = totalInput + turn.usage.outputTokens

    span.attribute = {
      ...this.commonAttributes(state),
      'gen_ai.span.kind': 'agent',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agentName,
      'gen_ai.agent.type': 'deepseek-harness',
      'gen_ai.response.finish_reasons': safeStringify([finishReason]),
      'gen_ai.usage.input_tokens': totalInput,
      'gen_ai.usage.output_tokens': turn.usage.outputTokens,
      'gen_ai.usage.total_tokens': totalTokens,
      ...(turn.model ? { 'gen_ai.request.model': turn.model } : {}),
      ...(turn.provider ? { 'gen_ai.system': turn.provider } : {}),
      ...(turn.usage.cacheReadTokens ? { 'gen_ai.usage.cache_read.input_tokens': turn.usage.cacheReadTokens } : {}),
      ...(turn.usage.cacheWriteTokens ? { 'gen_ai.usage.cache_creation.input_tokens': turn.usage.cacheWriteTokens } : {}),
      'dsh.turn': turn.turn,
      'dsh.turn.end_reason': finishReason,
    }

    // Conversation-level content capture
    if (this.config.captureContent && (turn.inputs.length > 0 || turn.outputs.length > 0)) {
      span.attribute['gen_ai.input.messages'] = truncate(safeStringify(turn.inputs), this.config.contentMaxChars)
      span.attribute['gen_ai.output.messages'] = truncate(
        safeStringify(turn.outputs.map(m => ({ role: m.role, parts: m.parts, finish_reason: m.finishReason }))),
        this.config.contentMaxChars,
      )
    }

    return span
  }

  private buildStepSpan(
    turn: TurnState,
    step: StepState,
    endTime: number,
    finishReason: string,
  ): CLSSpan {
    const span = createCLSSpan()
    const sessionState = [...this.sessions.values()].find(s => s.turn === turn)
    span.spanKind = 'step'
    span.traceID = turn.traceID
    span.spanID = step.spanId
    span.parentSpanID = turn.agentSpanId
    span.sessionID = sessionState?.sessionId ?? ''
    span.stepID = `${sessionState?.sessionId ?? ''}:t${turn.turn}:s${step.step}`
    span.name = `react round_${step.step}`
    span.kind = 'INTERNAL'
    span.statusCode = (finishReason === 'error' || finishReason === 'cancelled') ? 'ERROR' : 'OK'
    span.statusMessage = ''
    span.start = msToNanoStr(step.startTime)
    span.end = msToNanoStr(endTime)
    span.duration = durationNanoStr(step.startTime, endTime)
    span.durationMs = String(durationMs(step.startTime, endTime))
    span.host = this.hostname
    span.service = this.config.serviceName
    span.attribute = {
      'gen_ai.span.kind': 'step',
      'gen_ai.operation.name': 'react',
      'gen_ai.session.id': sessionState?.sessionId ?? '',
      'gen_ai.turn.id': `${sessionState?.sessionId ?? ''}:t${turn.turn}`,
      'gen_ai.step.id': `${sessionState?.sessionId ?? ''}:t${turn.turn}:s${step.step}`,
      'gen_ai.react.round': step.step,
      'gen_ai.react.finish_reason': finishReason,
      'dsh.step': step.step,
      'telemetry.sdk.name': 'tencentcloud-agentobs-sdk-dsh',
      'telemetry.sdk.language': 'javascript',
    }
    return span
  }

  private buildChatSpan(
    llm: LlmState,
    sessionState: SessionState,
    endTime: number,
    finishReason: string,
    isError: boolean,
    failure?: DshFailure,
  ): CLSSpan {
    const turn = sessionState.turn!
    const step = turn.step
    const model = llm.options.model
    const provider = llm.options.provider

    const span = createCLSSpan()
    span.spanKind = 'chat'
    span.traceID = turn.traceID
    span.spanID = llm.spanId
    span.parentSpanID = step?.spanId ?? turn.agentSpanId
    span.sessionID = sessionState.sessionId
    span.stepID = step ? `${sessionState.sessionId}:t${turn.turn}:s${step.step}` : ''
    span.name = `chat ${model}`
    span.kind = 'CLIENT'
    span.statusCode = isError ? 'ERROR' : 'OK'
    span.statusMessage = isError ? (failure?.message ?? 'LLM error') : ''
    span.start = msToNanoStr(llm.startTime)
    span.end = msToNanoStr(endTime)
    span.duration = durationNanoStr(llm.startTime, endTime)
    span.durationMs = String(durationMs(llm.startTime, endTime))
    span.host = this.hostname
    span.service = this.config.serviceName

    const attrs: CLSSpanAttributes = {
      'gen_ai.span.kind': 'chat',
      'gen_ai.operation.name': 'chat',
      'gen_ai.session.id': sessionState.sessionId,
      'gen_ai.turn.id': `${sessionState.sessionId}:t${turn.turn}`,
      'gen_ai.step.id': step ? `${sessionState.sessionId}:t${turn.turn}:s${step.step}` : '',
      'gen_ai.system': provider,
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.finish_reasons': safeStringify([finishReason]),
      'telemetry.sdk.name': 'tencentcloud-agentobs-sdk-dsh',
      'telemetry.sdk.language': 'javascript',
    }

    // Token usage
    if (llm.usage) {
      const cacheRead = llm.usage.cacheReadTokens ?? 0
      const cacheWrite = llm.usage.cacheWriteTokens ?? 0
      const totalInput = llm.usage.inputTokens + cacheRead + cacheWrite
      attrs['gen_ai.usage.input_tokens'] = totalInput
      attrs['gen_ai.usage.output_tokens'] = llm.usage.outputTokens
      attrs['gen_ai.usage.total_tokens'] = totalInput + llm.usage.outputTokens
      if (cacheRead) attrs['gen_ai.usage.cache_read.input_tokens'] = cacheRead
      if (cacheWrite) attrs['gen_ai.usage.cache_creation.input_tokens'] = cacheWrite
      if (llm.usage.reasoningTokens) attrs['gen_ai.usage.reasoning_tokens'] = llm.usage.reasoningTokens
    }

    // TTFT (high-precision monotonic clock)
    if (llm.firstTokenMono !== undefined) {
      attrs['gen_ai.response.time_to_first_token_ms'] = Math.round(llm.firstTokenMono - llm.startMono)
    }

    // Temperature / max tokens / reasoning effort / attempt / stop sequences
    if (llm.options.temperature !== undefined) {
      attrs['gen_ai.request.temperature'] = llm.options.temperature
    }
    if (llm.options.maxTokens !== undefined) {
      attrs['gen_ai.request.max_tokens'] = llm.options.maxTokens
    }
    if (llm.options.reasoningEffort !== undefined) {
      attrs['gen_ai.request.reasoning_effort'] = llm.options.reasoningEffort
    }
    if (llm.options.stop !== undefined && llm.options.stop.length > 0) {
      attrs['gen_ai.request.stop_sequences'] = safeStringify(llm.options.stop)
    }
    attrs['dsh.llm.attempt'] = llm.attempt
    attrs['dsh.step'] = step?.step ?? 0

    // Content capture
    if (this.config.captureContent) {
      const inputMsgs = mapInputMessages(llm.options.messages)
      attrs['gen_ai.input.messages'] = truncate(safeStringify(inputMsgs), this.config.contentMaxChars)

      if (llm.blocks.length > 0) {
        const output = mapOutputMessage(llm.blocks as DshContentBlock[], finishReason)
        attrs['gen_ai.output.messages'] = truncate(safeStringify([output]), this.config.contentMaxChars)
      }

      attrs['gen_ai.system_instructions'] = truncate(
        safeStringify(mapSystemInstruction(llm.options.system)),
        this.config.contentMaxChars,
      )
      attrs['gen_ai.tool.definitions'] = truncate(
        safeStringify(mapToolDefinitions(llm.options.tools)),
        this.config.contentMaxChars,
      )
    }

    span.attribute = attrs
    return span
  }

  private buildToolSpan(
    state: SessionState,
    tool: ToolState,
    endTime: number,
    result: unknown[],
    isError: boolean,
    error?: { name: string; code: string },
  ): CLSSpan {
    const turn = state.turn!
    const step = turn.step!

    const span = createCLSSpan()
    span.spanKind = 'tool'
    span.traceID = turn.traceID
    span.spanID = tool.spanId
    span.parentSpanID = step.spanId
    span.sessionID = state.sessionId
    span.stepID = `${state.sessionId}:t${turn.turn}:s${step.step}`
    span.name = `execute_tool ${tool.name}`
    span.kind = 'CLIENT'
    span.statusCode = isError ? 'ERROR' : 'OK'
    span.statusMessage = isError ? (error?.name ?? 'Tool execution failed') : ''
    span.start = msToNanoStr(tool.startTime)
    span.end = msToNanoStr(endTime)
    span.duration = durationNanoStr(tool.startTime, endTime)
    span.durationMs = String(durationMs(tool.startTime, endTime))
    span.host = this.hostname
    span.service = this.config.serviceName

    const attrs: CLSSpanAttributes = {
      'gen_ai.span.kind': 'tool',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.session.id': state.sessionId,
      'gen_ai.turn.id': `${state.sessionId}:t${turn.turn}`,
      'gen_ai.step.id': `${state.sessionId}:t${turn.turn}:s${step.step}`,
      'gen_ai.tool.name': tool.name,
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': tool.callId,
      'gen_ai.tool.call.duration_ms': durationMs(tool.startTime, endTime),
      'telemetry.sdk.name': 'tencentcloud-agentobs-sdk-dsh',
      'telemetry.sdk.language': 'javascript',
    }

    if (this.config.captureContent) {
      attrs['gen_ai.tool.call.arguments'] = truncate(
        safeStringify(parseToolArguments(tool.arguments)),
        this.config.contentMaxChars,
      )
      attrs['gen_ai.tool.call.result'] = truncate(safeStringify(result), this.config.contentMaxChars)
    }

    if (isError) {
      attrs['gen_ai.tool.error.type'] = error?.code ?? 'tool_error'
      attrs['gen_ai.tool.error.message'] = error?.name ?? 'Tool execution failed'
      attrs['error.type'] = 'ToolError'
    }

    span.attribute = attrs
    return span
  }

  private debug(message: string): void {
    if (this.config.debug) this.logger.debug?.(`[cls-dsh] ${message}`)
  }

  private warn(message: string): void {
    this.logger.warn(`[cls-dsh] ${message}`)
  }
}
