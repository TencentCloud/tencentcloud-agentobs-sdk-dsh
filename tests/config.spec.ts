import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Config, resolveCaptureContent, resolveClsConfig } from '../src/config.js'
import { testConfig } from './helpers.js'

const require = createRequire(import.meta.url)

describe('maxBatchBytes vs. the CLS SDK limit', () => {
  it('keeps the default below the size the SDK enforces locally', () => {
    // The SDK rejects an oversize LogGroup before sending, throwing
    // InvalidLogSize. Retrying never helps, so our default must stay under it.
    const { CONST_MAX_PUT_SIZE } = require(
      'tencentcloud-cls-sdk-js/dist/common/constants.js',
    ) as { CONST_MAX_PUT_SIZE: number }

    const applied = new Config({} as Config) as { maxBatchBytes: number }

    expect(CONST_MAX_PUT_SIZE).toBeGreaterThan(0)
    expect(applied.maxBatchBytes).toBeLessThan(CONST_MAX_PUT_SIZE)
  })
})

describe('resolveCaptureContent', () => {
  it('enables content capture by default when neither config nor environment is set', () => {
    expect(resolveCaptureContent(undefined, {})).toBe(true)
  })

  it.each(['false', 'FALSE', 'NO', 'off', 'DISABLED', '0'])(
    'disables content capture for environment mode %s',
    (mode) => {
      expect(resolveCaptureContent(undefined, {
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: mode,
      })).toBe(false)
    },
  )

  it.each(['SPAN_ONLY', 'span_and_event', 'TRUE', 'true', 'anything_else'])(
    'keeps content enabled for environment mode %s',
    (mode) => {
      expect(resolveCaptureContent(undefined, {
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: mode,
      })).toBe(true)
    },
  )

  it('gives an explicit plugin setting precedence over the environment', () => {
    expect(resolveCaptureContent(false, {
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'TRUE',
    })).toBe(false)
    expect(resolveCaptureContent(true, {
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'FALSE',
    })).toBe(true)
  })
})

describe('resolveClsConfig', () => {
  it('returns missing fields when required CLS config is absent', () => {
    const config = testConfig({ endpoint: '', topicId: '' })
    // Clear env vars for this test
    const env = process.env
    delete env['CLS_ENDPOINT']
    delete env['CLS_TOPIC_ID']
    const result = resolveClsConfig(config)
    expect('missing' in result).toBe(true)
    if ('missing' in result) {
      expect(result.missing).toContain('CLS_ENDPOINT')
      expect(result.missing).toContain('CLS_TOPIC_ID')
    }
  })

  it('resolves full config from plugin settings', () => {
    const config = testConfig()
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.endpoint).toBe('ap-guangzhou.cls.tencentcs.com')
      expect(resolved.topicId).toBe('test-topic-id-12345')
      expect(resolved.serviceName).toBe('dsh-test')
      expect(resolved.captureContent).toBe(false)
    }
  })

  it('resolves authless (weak auth) config when uin is provided and secrets are absent', () => {
    delete process.env['CLS_SECRET_ID']
    delete process.env['CLS_SECRET_KEY']
    delete process.env['CLS_UIN']
    const config = testConfig({ secretId: '', secretKey: '', uin: '100000000000' })
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.secretId).toBe('')
      expect(resolved.secretKey).toBe('')
      expect(resolved.uin).toBe('100000000000')
    }
  })

  it('resolves uin from environment variables', () => {
    process.env['CLS_UIN'] = '100000000000'
    const config = testConfig({ secretId: '', secretKey: '', uin: '' })
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.uin).toBe('100000000000')
    }
    delete process.env['CLS_UIN']
  })

  it('reports missing auth when neither strong nor weak credentials are present', () => {
    delete process.env['CLS_SECRET_ID']
    delete process.env['CLS_SECRET_KEY']
    delete process.env['CLS_UIN']
    const config = testConfig({ secretId: '', secretKey: '', uin: '' })
    const result = resolveClsConfig(config)
    expect('missing' in result).toBe(true)
    if ('missing' in result) {
      expect(result.missing).toContain('CLS_SECRET_ID + CLS_SECRET_KEY (or CLS_UIN)')
    }
  })

  it('reports invalid uin when it is not digits-only', () => {
    delete process.env['CLS_SECRET_ID']
    delete process.env['CLS_SECRET_KEY']
    const config = testConfig({ secretId: '', secretKey: '', uin: 'not-a-number' })
    const result = resolveClsConfig(config)
    expect('missing' in result).toBe(true)
    if ('missing' in result) {
      expect(result.missing).toContain('CLS_UIN (must be a digits-only string)')
    }
  })

  it('falls back to environment variables', () => {
    process.env['CLS_ENDPOINT'] = 'ap-shanghai.cls.tencentcs.com'
    process.env['CLS_TOPIC_ID'] = 'env-topic'
    process.env['CLS_SECRET_ID'] = 'env-id'
    process.env['CLS_SECRET_KEY'] = 'env-key'
    const config = testConfig({
      endpoint: '',
      topicId: '',
      secretId: '',
      secretKey: '',
    })
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.endpoint).toBe('ap-shanghai.cls.tencentcs.com')
      expect(resolved.topicId).toBe('env-topic')
    }
    // Cleanup
    delete process.env['CLS_ENDPOINT']
    delete process.env['CLS_TOPIC_ID']
    delete process.env['CLS_SECRET_ID']
    delete process.env['CLS_SECRET_KEY']
  })

  it('merges resourceAttributes from env and plugin config (plugin wins)', () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'env.key=env-value,deployment.environment=staging'
    const config = testConfig({
      resourceAttributes: { 'deployment.environment': 'production', 'custom.tag': 'hello' },
    })
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.resourceAttributes).toEqual({
        'env.key': 'env-value',
        'deployment.environment': 'production', // plugin wins over env
        'custom.tag': 'hello',
      })
    }
    delete process.env['OTEL_RESOURCE_ATTRIBUTES']
  })

  it('parses OTEL_RESOURCE_ATTRIBUTES with edge cases', () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'a=1,b=2=3,,=invalid,c='
    const config = testConfig({ resourceAttributes: {} })
    const resolved = resolveClsConfig(config)
    expect('missing' in resolved).toBe(false)
    if (!('missing' in resolved)) {
      expect(resolved.resourceAttributes).toEqual({
        'a': '1',
        'b': '2=3',
        'c': '',
      })
    }
    delete process.env['OTEL_RESOURCE_ATTRIBUTES']
  })
})
