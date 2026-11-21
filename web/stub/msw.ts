// MSW adapter (spec §7.4): the same `handle()` in the browser (setupWorker: `dev:msw`, Pages) and in
// Vitest (setupServer). Neither environment has a server-side cookie jar we control, so cookies
// travel through `document.cookie`:
//   - request cookies = MSW's parsed cookies merged with document.cookie
//   - response cookies are returned as Set-Cookie AND, with `writeDocumentCookies`, written to
//     document.cookie by the adapter (the §11-2 fallback; see spec/journal.md for which runtime needs it)
import { http, HttpResponse, type HttpHandler } from 'msw'
import { handle, parseBody, parseCookies, type StubContext, type StubCookie } from './handlers.ts'

export const STUB_PATH_PATTERNS = ['/login', '/logout', '/current-user', '/databases/*', '/__stub/reset'] as const

export type MswAdapterOptions = { writeDocumentCookies: boolean }

export function createStubHandlers(ctx: StubContext, opts: MswAdapterOptions): HttpHandler[] {
  // Without reset (Pages build) the route is not registered at all, so it is truly absent (AC-STUB-14).
  const patterns = STUB_PATH_PATTERNS.filter((p) => ctx.allowReset || p !== '/__stub/reset')
  return patterns.map((pattern) =>
    http.all(pattern, async ({ request, cookies }) => {
      const url = new URL(request.url)
      const headers: Record<string, string | undefined> = {}
      request.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value
      })

      const out = handle(
        {
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers,
          cookies: { ...cookies, ...documentCookies() },
          body: parseBody(await request.text()),
        },
        ctx,
      )

      if (opts.writeDocumentCookies) out.setCookies.forEach(writeDocumentCookie)
      const responseHeaders = new Headers(out.headers)
      for (const cookie of out.setCookies)
        responseHeaders.append('Set-Cookie', `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=/`)
      return new HttpResponse(out.body, { status: out.status, headers: responseHeaders })
    }),
  )
}

function documentCookies(): Record<string, string> {
  return typeof document === 'undefined' ? {} : parseCookies(document.cookie)
}

function writeDocumentCookie(cookie: StubCookie): void {
  if (typeof document === 'undefined') return
  // HttpOnly can't be set from script; the in-browser stub accepts that (it is a demo, not a server).
  document.cookie = `${cookie.name}=${encodeURIComponent(cookie.value)}; path=/`
}
