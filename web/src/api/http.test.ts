import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { login, requestCurrentUser } from '../auth/currentUser.ts'
import { closeLoginDialog } from '../auth/loginDialog.ts'
import { RetryCancelledError, retryQueue } from '../auth/retryQueue.ts'
import { recordRequests, resetClientState } from '../test/renderRoute.tsx'
import { failNext, resetStub } from '../test/stubControl.ts'
import { PROJECT, SPRINT, BACKLOG } from '../../stub/seed.ts'
import { ApiError } from './errors.ts'
import { hasPendingRequests, parseResponseBody, request, usePendingRequests } from './http.ts'

function xsrfCookie(): string | undefined {
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie)
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
}

const newTask = {
  projectId: PROJECT.webshop,
  sprintId: SPRINT.webshop1,
  productBacklogItemId: BACKLOG.catalogue,
  name: 'Retry me',
  desc: 'Queued on a 401',
  estimation: 1,
  remaining: 1,
  state: 'TODO',
}

beforeEach(() => resetClientState())

describe('api/http', () => {
  it("AC-API-01: the )]}',\\n prefix is stripped before parsing; bodies without it also parse", async () => {
    expect(parseResponseBody(')]}\',\n{"user":null}')).toEqual({ user: null })
    expect(parseResponseBody('[1,2]')).toEqual([1, 2])
    expect(parseResponseBody('Forbidden')).toBe('Forbidden') // the stub's text/plain 403 stays text
    expect(parseResponseBody('')).toBeUndefined()
    // Through the stub, which prefixes every JSON body (AC-STUB-01).
    await expect(request('GET', '/current-user')).resolves.toEqual({ user: null })
  })

  it('AC-API-02: requests are same-origin with credentials; unsafe methods send X-XSRF-TOKEN = the cookie read at send time', async () => {
    const seen = recordRequests()
    await request('GET', '/current-user') // sets the XSRF-TOKEN cookie
    const token = xsrfCookie()
    expect(token).toBeTruthy()
    await request('POST', '/logout')
    // Change the cookie: the next request must read the new value, not a cached one.
    document.cookie = 'XSRF-TOKEN=changed-by-test; path=/'
    await expect(request('POST', '/logout')).rejects.toMatchObject({ status: 403 })

    expect(seen.map((r) => [r.method, r.pathname, r.headers.get('x-xsrf-token')])).toEqual([
      ['GET', '/current-user', null],
      ['POST', '/logout', token],
      ['POST', '/logout', 'changed-by-test'],
    ])
    expect(seen.every((r) => r.credentials === 'same-origin')).toBe(true)
  })

  it('AC-API-07: a 401 enqueues unauthorized-server; the retry is re-sent with fresh headers and the caller gets its outcome', async () => {
    const seen = recordRequests()
    await requestCurrentUser()
    const tokenBefore = xsrfCookie()

    const saving = request('POST', '/databases/ascrum/collections/tasks', { body: newTask }) // anonymous → 401
    await waitFor(() => expect(retryQueue.retryReason()).toBe('unauthorized-server'))

    // A new session (new XSRF token) before the login: a retry with the old headers would get a 403.
    resetStub()
    await requestCurrentUser()
    const tokenAfter = xsrfCookie()
    expect(tokenAfter).not.toBe(tokenBefore)
    await login('dev1@ascrum.test', 'demo') // closes the dialog the 401 opened → retryAll

    await expect(saving).resolves.toMatchObject({ name: 'Retry me', _id: { $oid: expect.any(String) } })
    const posts = seen.filter((r) => r.method === 'POST' && r.pathname.endsWith('/tasks'))
    expect(posts.map((r) => r.headers.get('x-xsrf-token'))).toEqual([tokenBefore, tokenAfter])
  })

  it('AC-API-07: the caller rejects when the login is cancelled', async () => {
    await requestCurrentUser()
    const saving = request('POST', '/databases/ascrum/collections/tasks', { body: newTask })
    await waitFor(() => expect(retryQueue.hasMore()).toBe(true))
    closeLoginDialog(false)
    await expect(saving).rejects.toBeInstanceOf(RetryCancelledError)
  })

  it('AC-API-08: usePendingRequests() is true while at least one request is in flight', async () => {
    const { result } = renderHook(() => usePendingRequests())
    expect(result.current).toBe(false)
    let both: Promise<unknown> = Promise.resolve()
    act(() => {
      both = Promise.all([request('GET', '/current-user'), request('GET', '/databases/ascrum/collections/users')])
    })
    expect(result.current).toBe(true)
    await act(() => both)
    expect(result.current).toBe(false)
  })

  it('D10: a non-2xx response rejects with ApiError instead of resolving undefined', async () => {
    failNext('GET', '/databases/ascrum/collections/projects', 500)
    const error: unknown = await request('GET', '/databases/ascrum/collections/projects').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 500, body: { message: 'Injected 500 by failNext()' } })
  })
})

// Legacy common/security/interceptor.spec.js
describe('legacy securityInterceptor cases', () => {
  it('accepts and returns a promise', () => {
    const result = request('GET', '/current-user')
    expect(result).toBeInstanceOf(Promise)
    return result
  })

  it('does not intercept non-401 error responses', async () => {
    failNext('GET', '/current-user', 400)
    await expect(request('GET', '/current-user')).rejects.toMatchObject({ status: 400 })
    expect(retryQueue.hasMore()).toBe(false)
  })

  it('intercepts 401 error responses and adds it to the retry queue', async () => {
    failNext('GET', '/current-user', 401)
    void request('GET', '/current-user').catch(() => undefined)
    await waitFor(() => expect(retryQueue.hasMore()).toBe(true))
    expect(retryQueue.retryReason()).toBe('unauthorized-server')
  })
})

// Legacy common/services/httpRequestTracker.spec.js
describe('legacy httpRequestTracker cases', () => {
  it('should not report pending requests if no requests in progress', () => {
    expect(hasPendingRequests()).toBe(false)
  })

  it('should report pending requests if requests are in progress', async () => {
    const inFlight = request('GET', '/current-user')
    expect(hasPendingRequests()).toBe(true)
    await inFlight
    expect(hasPendingRequests()).toBe(false)
  })
})
