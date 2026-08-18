/**
 * CLS Span model — each span is one JSON log entry in Tencent Cloud CLS.
 * Aligned with the CLS GenAI observability specification (5-layer model):
 *   entry → agent → step → chat/tool
 */

export interface CLSSpanAttributes {
  [key: string]: string | number | boolean
}

export interface CLSSpan {
  /** 5-layer span semantic kind: entry | agent | step | chat | tool */
  spanKind: string
  /** 32-char hex trace ID */
  traceID: string
  /** 16-char hex span ID */
  spanID: string
  /** 16-char hex parent span ID, empty for root */
  parentSpanID: string
  /** Session ID for cross-trace correlation */
  sessionID: string
  /** Agent ID */
  agentID: string
  /** Parent agent ID (for subagents) */
  parentAgentID: string
  /** Step ID */
  stepID: string
  /** Human-readable span name */
  name: string
  /** OTel span kind: INTERNAL | CLIENT | SERVER */
  kind: string
  /** Status code: OK | ERROR | UNSET */
  statusCode: string
  /** Error description */
  statusMessage: string
  /** Start time (nanosecond epoch string) */
  start: string
  /** End time (nanosecond epoch string) */
  end: string
  /** Duration (nanoseconds string) */
  duration: string
  /** Duration in milliseconds */
  durationMs: string
  /** Host name */
  host: string
  /** Service name */
  service: string
  /** Links JSON array string */
  links: string
  /** L2/L3/L4/L5 nested attributes */
  attribute: CLSSpanAttributes
}

/** Create a new empty CLS span with defaults. */
export function createCLSSpan(): CLSSpan {
  return {
    spanKind: '',
    traceID: '',
    spanID: '',
    parentSpanID: '',
    sessionID: '',
    agentID: '',
    parentAgentID: '',
    stepID: '',
    name: '',
    kind: 'INTERNAL',
    statusCode: 'UNSET',
    statusMessage: '',
    start: '',
    end: '',
    duration: '',
    durationMs: '',
    host: '',
    service: '',
    links: '[]',
    attribute: {},
  }
}
