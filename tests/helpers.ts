import type { Config, ResolvedClsConfig } from '../src/config.js'
import type {
  DshContentBlock,
  DshGenerateOptions,
  DshMessage,
  DshSession,
  DshSessionEvent,
  DshStreamChunk,
} from '../src/dsh-types.js'

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    endpoint: 'ap-guangzhou.cls.tencentcs.com',
    topicId: 'test-topic-id-12345',
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key',
    uin: '',
    serviceName: 'dsh-test',
    resourceAttributes: {},
    captureContent: false,
    contentMaxChars: 128_000,
    batchMaxSize: 32,
    maxQueueSize: 2048,
    flushIntervalMs: 5_000,
    retryTimes: 3,
    debug: false,
    ...overrides,
  }
}

export function testResolvedConfig(overrides: Partial<ResolvedClsConfig> = {}): ResolvedClsConfig {
  return {
    endpoint: 'ap-guangzhou.cls.tencentcs.com',
    topicId: 'test-topic-id-12345',
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key',
    uin: '',
    serviceName: 'dsh-test',
    resourceAttributes: {},
    captureContent: false,
    contentMaxChars: 128_000,
    batchMaxSize: 32,
    maxQueueSize: 2048,
    flushIntervalMs: 5_000,
    retryTimes: 3,
    debug: false,
    ...overrides,
  }
}

export function session(id = 'session-test'): DshSession {
  return {
    id,
    header: {
      id,
      createdAt: Date.now() - 1_000,
      cwd: '/tmp/project',
      agentPreset: 'default',
    },
    firstLiveSeq: 0,
    events: [],
  }
}

export function message(
  id: string,
  role: DshMessage['role'],
  content: DshContentBlock[],
  source: DshMessage['source'],
): DshMessage {
  return { id, role, content, source }
}

export function event(
  type: string,
  data: unknown,
  seq: number,
  time: number,
): DshSessionEvent {
  return { type, data, seq, time } as DshSessionEvent
}

export function llmOptions(sessionId = 'session-test'): DshGenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    messages: [message(
      'user-1',
      'user',
      [{ type: 'text', text: 'Hello from DSH' }],
      { kind: 'user' },
    )],
    system: 'You are a concise assistant.',
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    sessionId,
  }
}

export async function collect(stream: AsyncIterable<DshStreamChunk>): Promise<DshStreamChunk[]> {
  const chunks: DshStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

export function successfulStream(): AsyncIterable<DshStreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Hi' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi!' } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: 2,
        reasoningTokens: 1,
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

export const logger = {
  messages: [] as string[],
  info(message: string): void { this.messages.push(message) },
  warn(message: string): void { this.messages.push(message) },
  error(message: string): void { this.messages.push(message) },
  debug(message: string): void { this.messages.push(message) },
}
