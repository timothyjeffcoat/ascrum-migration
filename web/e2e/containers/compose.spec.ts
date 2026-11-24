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

test('§3.3: the production configuration answers 404 to POST /__stub/reset and resets nothing', async () => {
  // web-prod: nginx does not route the reset path at all (ROUTE_STUB_CONTROL defaults to off).
  const web = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_WEB_URL') })
  // api-prod: the API image without ALLOW_RESET, reached directly, so nginx cannot hide the answer.
  const api = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_API_URL') })
  try {
    expect((await web.post('/__stub/reset')).status()).toBe(404)

    // Sign in on api-prod, so a reset would show: it truncates the sessions table.
    await api.get('/current-user')
    const login = await api.post('/login', {
      data: { email: 'admin@abc.com', password: 'changeme' },
      headers: await xsrfHeader(api),
    })
    expect(login.status()).toBe(200)

    // With a valid session and XSRF header, the request gets past the XSRF check to routing: 404.
    expect((await api.post('/__stub/reset', { headers: await xsrfHeader(api) })).status()).toBe(404)
    // Without them, today's handle() stops it at the XSRF check (403) before routing. p5-security makes
    // that a 404 too (AC-SEC-03); whichever of the two PRs merges second narrows this to 404
    // (Q-p5-containers-2). Either way it is refused.
    const bare = await playwrightRequest.newContext({ baseURL: url('E2E_PROD_API_URL') })
    try {
      expect([403, 404]).toContain((await bare.post('/__stub/reset')).status())
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
