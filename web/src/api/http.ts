// The one place that talks HTTP (spec §4). It replaces three legacy pieces:
//   - AngularJS $http's JSON-prefix stripping and XSRF header (inventory §9.1);
//   - security/interceptor.js: a 401 queues a retry of the request on the retry queue;
//   - services/httpRequestTracker.js: a pending-request counter for the header spinner.
import { useSyncExternalStore } from 'react'
import { retryQueue } from '../auth/retryQueue.ts'
import { ApiError } from './errors.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
export type RequestOptions = { query?: Record<string, string>; body?: unknown }

const XSRF_COOKIE = 'XSRF-TOKEN'
const XSRF_HEADER = 'X-XSRF-TOKEN'
const SAFE_METHODS: ReadonlySet<Method> = new Set(['GET'])
/** The same pattern AngularJS 1.2 stripped: `)]}',` plus a newline, the comma optional. */
const JSON_PREFIX = /^\)\]\}',?\n/

// --- pending requests (legacy httpRequestTracker) ---------------------------------------------
let pending = 0
const pendingListeners = new Set<() => void>()

function changePending(delta: number): void {
  pending += delta
  for (const listener of pendingListeners) listener()
}

export function hasPendingRequests(): boolean {
  return pending > 0
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

/** AC-API-08: true while at least one request is in flight. */
export function usePendingRequests(): boolean {
  return useSyncExternalStore(subscribePending, hasPendingRequests)
}

// --- request ------------------------------------------------------------------------------------
function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/** AC-API-01: strip the anti-JSON-hijacking prefix if present, then parse; non-JSON bodies stay text. */
export function parseResponseBody(text: string): unknown {
  const body = text.replace(JSON_PREFIX, '')
  if (body.trim() === '') return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

/**
 * Sends a same-origin request with credentials and resolves with the parsed body.
 * - Unsafe methods carry `X-XSRF-TOKEN` = the `XSRF-TOKEN` cookie, read when the request is sent (AC-API-02).
 * - A 401 is queued as `unauthorized-server`; the caller's promise settles with the retry's outcome,
 *   or rejects when the login is cancelled (AC-API-07). The retry rebuilds the headers.
 * - Any other non-2xx rejects with ApiError (D10).
 */
export function request(method: Method, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const send = async (): Promise<unknown> => {
    // Absolute URL: the API lives at the origin root even when the app has a basename (Pages build).
    const url = new URL(path, window.location.origin)
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value)

    const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json;charset=utf-8'
    if (!SAFE_METHODS.has(method)) {
      const token = readCookie(XSRF_COOKIE)
      if (token !== undefined) headers[XSRF_HEADER] = token
    }

    changePending(+1)
    let status: number
    let text: string
    try {
      const response = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      status = response.status
      text = await response.text()
    } catch {
      throw new ApiError(0) // network failure: AngularJS reported status 0
    } finally {
      changePending(-1)
    }

    if (status === 401) return retryQueue.pushRetryFn('unauthorized-server', send)
    const body = parseResponseBody(text)
    if (status < 200 || status > 299) throw new ApiError(status, { body })
    return body
  }
  return send()
}
