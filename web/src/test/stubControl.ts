// Test controls (spec §13 item 5). resetStub() runs before every test from setup.ts.
// Per-test `server.use()` overrides are allowed for error injection; mocking api/ is not.
import { http, HttpResponse } from 'msw'
import { resetStore } from '../../stub/store.ts'
import { JSON_PREFIX, parseCookies } from '../../stub/handlers.ts'
import { server, stubContext } from './server.ts'

/** Reseed the store, drop every session, and clear the cookies jsdom holds. */
export function resetStub(): void {
  resetStore(stubContext.store)
  stubContext.sessions.clear()
  for (const name of Object.keys(parseCookies(document.cookie))) {
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * The next request matching method + path pattern (MSW syntax, e.g. '/databases/ascrum/collections/tasks/*')
 * fails with `status`. A 401 carries `{user:null}` like the legacy server; other statuses carry `{message}`.
 */
export function failNext(method: Method, pathPattern: string, status: number): void {
  const value = status === 401 ? { user: null } : { message: `Injected ${status} by failNext()` }
  const handlerFor = { GET: http.get, POST: http.post, PUT: http.put, DELETE: http.delete }[method]
  server.use(
    handlerFor(
      pathPattern,
      () =>
        new HttpResponse(JSON_PREFIX + JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      { once: true },
    ),
  )
}
