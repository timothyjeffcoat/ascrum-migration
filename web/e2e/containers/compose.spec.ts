// Container checks against the running compose stack (cluster p5-containers). Run only by
// `pnpm e2e:compose` (E2E_BASE_URL set, see playwright.config.ts), never by `pnpm e2e`, which starts
// its own servers and has no containers.
//
//   E2E_BASE_URL       web     (ROUTE_STUB_CONTROL=on, its API has ALLOW_RESET=1: local/CI configuration)
//   E2E_API_URL        api     (published port, for /healthz, which the web origin does not route)
//   E2E_PROD_WEB_URL   web-prod (profile prod-check: the web image with its defaults)
//   E2E_PROD_API_URL   api-prod (profile prod-check: the API image with its defaults, no ALLOW_RESET)
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test'

const JSON_PREFIX = ")]}',\n"

/** A missing URL fails the run (gate rule: never skip). */
function url(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run the container checks with \`pnpm e2e:compose\``)
  return value
}

/**
 * The map the web image must serve, read from the module itself (p5-security's web/securityHeaders.ts),
 * so this test and the image cannot disagree with it. Loaded by computed path because the module does
 * not exist on this branch until p5-security merges; the image build fails without it anyway.
 */
async function expectedHeaders(): Promise<Record<string, string>> {
  const mod = (await import(new URL('../../securityHeaders.ts', import.meta.url).href)) as Record<string, unknown>
  const headers = mod.securityHeaders
  expect(typeof headers === 'object' && headers !== null && Object.keys(headers).length > 0).toBe(true)
  return headers as Record<string, string>
}

/** Every header in the map exactly once, with exactly its value. */
function expectSecurityHeaders(response: APIResponse, expected: Record<string, string>, what: string) {
  const sent = response.headersArray()
  for (const [name, value] of Object.entries(expected)) {
    const copies = sent.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)
    expect(copies, `${what}: ${name}`).toEqual([value])
  }
}

async function xsrfHeader(context: APIRequestContext): Promise<Record<string, string>> {
  const token = (await context.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? ''
  return { 'X-XSRF-TOKEN': decodeURIComponent(token) }
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__stub/reset')).status()).toBe(204)
})

test('AC-CTR-01 / §3.6: one origin: the contract paths reach the API, everything else is the production build', async ({
  request,
}) => {
  const user = await request.get('/current-user')
  expect(user.status()).toBe(200)
  expect(await user.text()).toBe(`${JSON_PREFIX}{"user":null}`)
  expect(user.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').length).toBeGreaterThan(0)

  const projects = await request.get('/databases/ascrum/collections/projects')
  expect(projects.status()).toBe(200)
  expect((await projects.text()).startsWith(JSON_PREFIX)).toBe(true)

  // The API's XSRF check answers, not nginx: Express 3's text "Forbidden" (handlers.ts).
  const login = await request.post('/login', { data: { email: 'admin@abc.com', password: 'changeme' } })
  expect([login.status(), await login.text()]).toEqual([403, 'Forbidden'])
  expect((await request.post('/logout')).status()).toBe(403)

  // Client-side routes get the app (SPA fallback), built for base "/" (not the Pages build).
  for (const path of ['/', '/projects/123/sprints', '/admin/users']) {
    const page = await request.get(path)
    expect(page.status(), path).toBe(200)
    const html = await page.text()
    expect(html, path).toContain('<div id="root">')
    expect(html, path).toMatch(/src="\/assets\/index-[^"]+\.js"/)
    expect(html, path).not.toContain('/ascrum-migration/')
  }
  // A missing hashed asset is a 404, not the app served as JavaScript.
  expect((await request.get('/assets/missing-0000.js')).status()).toBe(404)
  // /healthz is not part of the public origin: the web image does not route it to the API.
  expect((await (await request.get('/healthz')).text()).startsWith('<!doctype html>')).toBe(true)
})

test('AC-CTR-01 / S-p5-5: both web configurations send exactly web/securityHeaders.ts on every kind of response', async () => {
  const expected = await expectedHeaders()
  for (const base of [url('E2E_BASE_URL'), url('E2E_PROD_WEB_URL')]) {
    const context = await playwrightRequest.newContext({ baseURL: base })
    try {
      const index = await context.get('/')
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(await index.text())?.[1]
      expect(script).toBeDefined()
      const responses: [string, APIResponse][] = [
        ['index.html', index],
        ['SPA fallback', await context.get('/projects/123/sprints')],
        ['hashed asset', await context.get(script ?? '')],
        ['public file', await context.get('/img/spinner.gif')],
        ['missing asset (404)', await context.get('/assets/missing-0000.js')],
        ['API through the proxy', await context.get('/current-user')],
        ['API error through the proxy (403)', await context.post('/login', { data: {} })],
        ['reset route', await context.post('/__stub/reset')],
      ]
      for (const [what, response] of responses) expectSecurityHeaders(response, expected, `${base} ${what}`)
    } finally {
      await context.dispose()
    }
  }
})

test('AC-CTR-03: the API container answers /healthz with 200 and sets no cookie', async () => {
  const context = await playwrightRequest.newContext({ baseURL: url('E2E_API_URL') })
  try {
    const health = await context.get('/healthz')
    expect(health.status()).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(health.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')).toEqual([])
  } finally {
    await context.dispose()
  }
})

test('§3.3 / DEV-p5-containers-06: the production configuration answers 404 to POST /__stub/reset and resets nothing', async () => {
  // web-prod: nginx does not route the reset path at all (ROUTE_STUB_CONTROL defaults to off).
  const web = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_WEB_URL') })
  // api-prod: the API image without ALLOW_RESET, reached directly, so nginx cannot hide the answer.
  const api = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_API_URL') })
  try {
    // DEV-p5-containers-06: the 404 must be nginx's own, so the web-side lock is tested on its own. If
    // web-prod routed /__stub/ to api-prod, api-prod's 404 (the contract's JSON, below) would look the
    // same by status alone.
    const viaWeb = await web.post('/__stub/reset')
    expect(viaWeb.status()).toBe(404)
    expect(viaWeb.headers()['content-type']).toContain('text/html')
    const webBody = await viaWeb.text()
    expect(webBody).toContain('<center>nginx</center>')
    expect(webBody).not.toContain(JSON_PREFIX)

    // Sign in on api-prod, so a reset would show: it truncates the sessions table.
    await api.get('/current-user')
    const login = await api.post('/login', {
      data: { email: 'admin@abc.com', password: 'changeme' },
      headers: await xsrfHeader(api),
    })
    expect(login.status()).toBe(200)

    // With a valid session and XSRF header: 404.
    expect((await api.post('/__stub/reset', { headers: await xsrfHeader(api) })).status()).toBe(404)
    // Without them, also 404 (AC-SEC-03, p5-security): the route is answered before sessions and XSRF,
    // with no cookie. Narrowed from "403 or 404" once #59 merged (Q-p5-containers-2).
    const bare = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_API_URL') })
    try {
      const response = await bare.post('/__stub/reset')
      expect(response.status()).toBe(404)
      expect(await response.text()).toBe(`${JSON_PREFIX}{"message":"Not found"}`)
      expect(response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')).toEqual([])
    } finally {
      await bare.dispose()
    }

    const me = await api.get('/current-user')
    expect((await me.text()).startsWith(`${JSON_PREFIX}{"user":{`)).toBe(true) // still signed in: nothing reset
  } finally {
    await web.dispose()
    await api.dispose()
  }
})

test('§3.6 / DEV-p5-containers-07: nginx routes exactly the contract, keeps API errors, and gives nothing away', async () => {
  for (const base of [url('E2E_BASE_URL'), url('E2E_PROD_WEB_URL')]) {
    const context = await playwrightRequest.newContext({ baseURL: base })
    try {
      // A prefix match only with the slash: /databasesX is a client-side path (the app), not the API.
      const near = await context.get('/databasesX')
      expect(near.status(), `${base} /databasesX`).toBe(200)
      expect(await near.text(), `${base} /databasesX`).toContain('<div id="root">')

      // The API's 404s pass through as the API sent them: status, JSON prefix and message. nginx must not
      // turn them into the app's index.html (proxy_intercept_errors / error_page).
      for (const [path, message] of [
        ['/databases/ascrum/collections/nope', 'Unknown database or collection'],
        ['/databases/ascrum/collections/projects/000000000000000000000000', 'Document not found'],
      ] as const) {
        const missing = await context.get(path)
        expect(missing.status(), `${base} ${path}`).toBe(404)
        expect(missing.headers()['content-type'], `${base} ${path}`).toContain('application/json')
        expect(await missing.text(), `${base} ${path}`).toBe(`${JSON_PREFIX}{"message":"${message}"}`)
      }

      // No version anywhere (server_tokens off): not in the header, not on nginx's own error pages.
      for (const path of ['/', '/assets/missing-0000.js']) {
        const response = await context.get(path)
        expect(response.headers()['server'], `${base} ${path}`).toBe('nginx')
        expect(await response.text(), `${base} ${path}`).not.toMatch(/nginx\/\d/)
      }

      // No directory listing (autoindex) for the build's folders.
      const listing = await context.get('/assets/')
      expect(listing.status(), `${base} /assets/`).toBe(404)
      expect(await listing.text(), `${base} /assets/`).not.toContain('Index of')
    } finally {
      await context.dispose()
    }
  }
})

test('DEV-p5-containers-08: nginx never redirects to its internal port; redirects stay on the origin used', async () => {
  for (const base of [url('E2E_BASE_URL'), url('E2E_PROD_WEB_URL')]) {
    const context = await playwrightRequest.newContext({ baseURL: base })
    try {
      // /databases is the one nginx redirects today (to /databases/); the others are directories in the
      // build. Whatever answers a redirect must keep the caller's origin.
      const redirects: string[] = []
      for (const path of ['/databases', '/assets', '/img', '/databases/', '/assets/']) {
        const response = await context.get(path, { maxRedirects: 0 })
        const location = response.headers()['location']
        if (response.status() >= 300 && response.status() < 400) {
          expect(location, `${base} ${path}`).toBeDefined()
          expect(location, `${base} ${path}`).not.toContain(':8080')
          expect(new URL(location ?? '', base + path).origin, `${base} ${path}`).toBe(new URL(base).origin)
          redirects.push(path)
        }
      }
      // Not vacuous: at least the one known redirect was checked.
      expect(redirects, base).toContain('/databases')
    } finally {
      await context.dispose()
    }
  }
})
