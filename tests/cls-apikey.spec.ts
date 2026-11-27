import { createRequire } from 'node:module'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLSFlusher } from '../src/cls-flusher.js'
import { createCLSSpan } from '../src/cls-types.js'
import { logger, testResolvedConfig } from './helpers.js'

interface Received {
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
}

/** Local stand-in for CLS that records requests and answers with a fixed status. */
async function fakeCls(status: number, body = ''): Promise<{ server: Server, endpoint: string, received: Received[] }> {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(status, { 'x-cls-requestid': 'req-1' }).end(body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, endpoint: `http://127.0.0.1:${port}`, received }
}

function span(name: string) {
  const s = createCLSSpan()
  s.spanKind = 'chat'
  s.name = name
  s.traceID = 'a'.repeat(32)
  s.spanID = 'b'.repeat(16)
  return s
}

const require = createRequire(import.meta.url)

describe('tencentcloud-cls-sdk-js internals relied on for API Key auth', () => {
  it('still exposes the private send step and client fields that get replaced', () => {
    const { AsyncClient } = require('tencentcloud-cls-sdk-js') as {
      AsyncClient: new (o: Record<string, unknown>) => Record<string, unknown>
    }
    expect(typeof AsyncClient.prototype.sendLogs).toBe('function')
    const client = new AsyncClient({ endpoint: 'https://example.com', sourceIp: '127.0.0.1', uin: '0' })
    expect(client['httpType']).toBe('https://')
    expect(client['hostName']).toBe('example.com')
    expect(typeof client['userAgent']).toBe('string')
  })
})

describe('CLSFlusher API Key transport', () => {
  let server: Server | undefined
  let flusher: CLSFlusher | undefined

  beforeEach(() => {
    logger.messages.length = 0
  })

  afterEach(async () => {
    await flusher?.stop()
    await new Promise(resolve => server ? server.close(resolve) : resolve(undefined))
    server = undefined
    flusher = undefined
  })

  it('authenticates with x-cls-apikey and raw deflate, without signature or weak-auth headers', async () => {
    const cls = await fakeCls(200)
    server = cls.server
    flusher = new CLSFlusher(testResolvedConfig({
      endpoint: cls.endpoint,
      apiKey: 'test-api-key',
      secretId: 'ignored-id',
      secretKey: 'ignored-key',
      uin: '100000000000',
    }), logger)
    flusher.start()
    flusher.enqueue(span('chat apikey'))
    await flusher.flush()

    expect(cls.received).toHaveLength(1)
    const [req] = cls.received
    expect(req!.url).toBe('/structuredlog?topic_id=test-topic-id-12345')
    expect(req!.headers['x-cls-apikey']).toBe('test-api-key')
    expect(req!.headers['x-cls-compress-type']).toBe('deflate')
    expect(req!.headers['content-type']).toBe('application/x-protobuf')
    expect(req!.headers['user-agent']).toContain('agentobs-dsh-')
    expect(req!.headers['authorization']).toBeUndefined()
    expect(req!.headers['x-cls-auth-mode']).toBeUndefined()
    expect(req!.headers['x-cls-uin']).toBeUndefined()
    // The body is a raw-deflated LogGroupList carrying the span
    expect(inflateRawSync(req!.body).toString('latin1')).toContain('chat apikey')
    expect(logger.messages.join('\n')).not.toContain('test-api-key')
  })

  it('does not retry a 401 and does not leak the key in logs', async () => {
    const cls = await fakeCls(401, '{"errorcode":"Unauthorized","errormessage":"invalid api key"}')
    server = cls.server
    flusher = new CLSFlusher(testResolvedConfig({ endpoint: cls.endpoint, apiKey: 'wrong-api-key' }), logger)
    flusher.start()
    flusher.enqueue(span('chat unauthorized'))
    await flusher.flush()

    expect(cls.received).toHaveLength(1)
    const log = logger.messages.join('\n')
    expect(log).toContain('401 (non-retryable')
    expect(log).toContain('check CLS_API_KEY')
    expect(log).toContain('name=chat unauthorized')
    expect(log).not.toContain('wrong-api-key')
  })

  it('retries a 5xx through the SDK retry loop', async () => {
    const cls = await fakeCls(503)
    server = cls.server
    flusher = new CLSFlusher(testResolvedConfig({ endpoint: cls.endpoint, apiKey: 'test-api-key', retryTimes: 2 }), logger)
    flusher.start()
    flusher.enqueue(span('chat unavailable'))
    await flusher.flush()

    expect(cls.received).toHaveLength(2)
    expect(logger.messages.join('\n')).toContain('exceed retry times')
  })

  it('warns when the API Key would travel over plain http', () => {
    flusher = new CLSFlusher(testResolvedConfig({ endpoint: 'http://127.0.0.1:1', apiKey: 'test-api-key' }), logger)
    flusher.start()
    expect(logger.messages.join('\n')).toContain('sent in plaintext')
  })

  it('defaults a bare host to https when using an API Key', () => {
    flusher = new CLSFlusher(testResolvedConfig({ endpoint: 'ap-xian-ec.cls.tencentyun.com', apiKey: 'test-api-key' }), logger)
    flusher.start()
    const client = (flusher as unknown as { client: { httpType: string } }).client
    expect(client.httpType).toBe('https://')
    expect(logger.messages.join('\n')).not.toContain('plaintext')
  })

  it('leaves the SDK transport untouched without an API Key', () => {
    flusher = new CLSFlusher(testResolvedConfig(), logger)
    flusher.start()
    const client = (flusher as unknown as { client: object }).client
    expect(Object.prototype.hasOwnProperty.call(client, 'sendLogs')).toBe(false)
  })
})
