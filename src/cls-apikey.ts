/**
 * API Key authentication for tencentcloud-cls-sdk-js.
 *
 * CLS accepts an `x-cls-apikey` header on `/structuredlog`, but the SDK (1.1.1)
 * only knows request signing and UIN weak auth. The SDK still does the protobuf
 * encoding, size check and retry loop in `PutLogs`; only its private `sendLogs`
 * step is replaced here. `sendLogs` is not public API, so this is pinned to the
 * SDK version in package.json and must be re-verified on upgrade.
 */

import { deflateRawSync } from 'node:zlib'

/** Mirrors the SDK's `HTTP_SEND_TIME_OUT`. */
const SEND_TIMEOUT_MS = 60_000

/** Computed by fetch from the URL and body; forwarding the SDK's values would be wrong. */
const FETCH_MANAGED_HEADERS = new Set(['host', 'content-length'])

/** Placeholder UIN that satisfies the SDK constructor; never sent, since `sendLogs` is replaced. */
export const API_KEY_PLACEHOLDER_UIN = '0'

type SendLogs = (
  method: string,
  resourceUri: string,
  urlParameter: unknown,
  headParameter: Map<string, string>,
  body: Uint8Array,
  topic: string,
) => Promise<SendLogsResponse>

interface SendLogsResponse {
  status: number
  headers: Record<string, string>
  data: string
}

/** The `AsyncClient` internals this module relies on. */
export interface ApiKeyCapableClient {
  httpType: string
  hostName: string
  userAgent: string
  sendLogs: SendLogs
}

/**
 * Replace the client's send step with one that authenticates by API Key.
 *
 * Non-2xx responses are thrown in axios' error shape (`error.response.status`)
 * because that is what `PutLogs` inspects: 401/404/413 stop immediately, other
 * failures go through the SDK's retry loop as before.
 */
export function useApiKeyAuth(client: ApiKeyCapableClient, apiKey: string): void {
  client.sendLogs = async (_method, resourceUri, _urlParameter, headParameter, body, topic) => {
    const headers: Record<string, string> = {}
    headParameter.forEach((value, key) => {
      if (!FETCH_MANAGED_HEADERS.has(key.toLowerCase())) headers[key] = value
    })
    headers['User-Agent'] = client.userAgent
    // Must name the codec actually applied below, or CLS rejects the body.
    headers['x-cls-compress-type'] = 'deflate'
    headers['x-cls-apikey'] = apiKey

    const url = `${client.httpType}${client.hostName}${resourceUri}?topic_id=${encodeURIComponent(topic)}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: deflateRawSync(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const response: SendLogsResponse = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      data: await res.text(),
    }
    if (!res.ok) {
      throw Object.assign(new Error(`Request failed with status code ${res.status}`), { response })
    }
    return response
  }
}
