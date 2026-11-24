// AC-SEC-05 / S-p5-5 (p5-security): the production web build is served with the security headers in
// web/securityHeaders.ts (here by `vite preview`, which applies the same map the web image serves), and
// no screen triggers a Content-Security-Policy violation.
//
// Violations are collected two ways, so a missed event cannot hide one: the `securitypolicyviolation`
// DOM event (an init script, which Playwright injects outside the page's CSP) and Chromium's console
// report ("Refused to ... because it violates the following Content Security Policy directive").
// The Pages build is not covered: GitHub Pages cannot send response headers (see the worklog).
import { expect, test, type Page } from '@playwright/test'
import { securityHeaders } from '../securityHeaders.ts'
import { BACKLOG, PROJECT, SPRINT, USER } from '../stub/seed.ts'

type Violation = { directive: string; blocked: string; source: string }
declare global {
  interface Window {
    __cspViolations: Violation[]
    __inlineRan?: boolean
  }
}

const TASK_1 = '5' + (1).toString(16).padStart(23, '0') // seed.ts tasks: oid('5', n)
const webshop = `/projects/${PROJECT.webshop}`
const tasks = `${webshop}/sprints/${SPRINT.webshop1}/tasks`

/** Every screen of the app (spec §5.3 routes), as a deep link, signed in as the admin. */
const SCREENS = [
  '/projectsinfo',
  '/dashboard',
  '/projects',
  `${webshop}/productbacklog`,
  `${webshop}/productbacklog/new`,
  `${webshop}/productbacklog/${BACKLOG.cart}`,
  `${webshop}/sprints`,
  `${webshop}/sprints/new`,
  `${webshop}/sprints/${SPRINT.webshop1}`,
  tasks,
  `${tasks}/new`,
  `${tasks}/${TASK_1}`,
  '/admin/projects',
  '/admin/projects/new',
  `/admin/projects/${PROJECT.webshop}`,
  '/admin/users',
  '/admin/users/new',
  `/admin/users/${USER.po}`,
]

// A 1×1 transparent GIF: Gravatar images are answered locally, so the test never depends on the network.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const consoleReports: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) consoleReports.push(message.text())
  })
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
      })
    })
  })
  await page.route('https://www.gravatar.com/avatar/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }),
  )
  return async () => [
    ...(await page.evaluate(() => window.__cspViolations)).map((v) => `${v.directive} blocked ${v.blocked}`),
    ...consoleReports,
  ]
}

async function signInAsAdmin(page: Page) {
  await page.goto('/projectsinfo')
  await page.getByRole('button', { name: 'Log in' }).click()
  const modal = page.locator('.modal')
  await modal.getByLabel('E-mail').fill('admin@abc.com')
  await modal.getByLabel('Password').fill('changeme')
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByText('Admin User')).toBeVisible()
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__stub/reset')).status()).toBe(204)
})

test('AC-SEC-05: every page and asset the web build serves carries the security headers', async ({ page }) => {
  expect(Object.keys(securityHeaders).sort()).toEqual([
    'Content-Security-Policy',
    'Cross-Origin-Opener-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'X-Content-Type-Options',
    'X-Frame-Options',
  ])
  // allHeaders(), not headers(): Playwright's headers() leaves out security-related headers.
  const responses = new Map<string, Promise<Record<string, string>>>()
  page.on('response', (response) => {
    const { pathname } = new URL(response.url())
    // The first load of each asset; later navigations revalidate it (304) and reuse the cached headers.
    if (pathname.startsWith('/assets/') && !responses.has(pathname)) responses.set(pathname, response.allHeaders())
  })
  for (const path of ['/', '/projectsinfo', `/admin/users/${USER.po}`]) {
    const response = await page.goto(path)
    expect(response?.status(), path).toBe(200)
    const headers = await response?.allHeaders()
    for (const [name, value] of Object.entries(securityHeaders)) {
      expect(headers?.[name.toLowerCase()], `${path}: ${name}`).toBe(value)
    }
  }
  await expect(page.locator('#root > *').first()).toBeVisible()
  const assets = [...responses].filter(([path]) => path.startsWith('/assets/'))
  expect(assets.map(([path]) => path.replace(/-[\w-]+\./, '.'))).toEqual(
    expect.arrayContaining(['/assets/index.js', '/assets/index.css']),
  )
  for (const [path, pending] of assets) {
    const headers = await pending
    expect(headers['x-content-type-options'], path).toBe('nosniff')
    expect(headers['content-security-policy'], path).toBe(securityHeaders['Content-Security-Policy'])
  }
})

// DEV-p5-security-09: the test above compares the served headers with the same map the server sends, so
// any edit to the map agrees with itself. This one pins the policy itself, written out here on purpose
// (not imported), and also checks the rules any future policy must keep.
const EXPECTED_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'https://www.gravatar.com'], // Q-p5-security-1 (a)
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

/** "a b; c d" → [['a', ['b']], ['c', ['d']]]; a repeated directive stays twice, so the test sees it. */
function parseCsp(policy: string): [string, string[]][] {
  return policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .filter(([name]) => name)
    .map(([name = '', ...sources]) => [name.toLowerCase(), sources])
}

test('AC-SEC-05 / DEV-p5-security-09: the served CSP is exactly the expected policy: no unsafe-* source, no wildcard, images from self and Gravatar only', async ({
  request,
}) => {
  for (const path of ['/', '/projectsinfo']) {
    const policy = (await request.get(path)).headers()['content-security-policy'] ?? ''
    const directives = parseCsp(policy)
    expect(Object.fromEntries(directives), path).toEqual(EXPECTED_CSP)
    expect(directives, `${path}: no directive twice`).toHaveLength(Object.keys(EXPECTED_CSP).length)
    for (const [name, sources] of directives) {
      for (const source of sources) {
        expect(source, `${path}: ${name}`).not.toMatch(/^'unsafe-|^'wasm-unsafe-eval'$/)
        expect(source, `${path}: ${name}`).not.toMatch(/\*/)
        // A bare scheme allows every host on it.
        expect(source, `${path}: ${name}`).not.toMatch(/^(https?|wss?|blob|filesystem):$/)
        if (source === 'data:') expect(name, `${path}: data: outside img-src`).toBe('img-src')
      }
    }
    const img = directives.find(([name]) => name === 'img-src')?.[1] ?? []
    for (const source of img) expect(["'self'", 'data:', 'https://www.gravatar.com'], 'img-src').toContain(source)
  }
})

test('AC-SEC-05: the CSP allows the app’s own assets only: no violation on any screen, signed in as the admin', async ({
  page,
}) => {
  const violations = await watchCsp(page)
  // The login modal, anonymous.
  await signInAsAdmin(page)
  expect(await violations()).toEqual([])

  for (const path of SCREENS) {
    await page.goto(path)
    await expect(page.locator('.container-fluid').locator('form, table, h3').first(), path).toBeVisible()
    await expect(page.locator('.modal'), path).toHaveCount(0) // really signed in, not the login modal
    await page.waitForLoadState('networkidle')
    expect(await violations(), path).toEqual([])
  }
  // The user screens show Gravatar images (AC-GRAV-01): allowed by img-src, and they did load.
  await page.goto('/admin/users')
  const avatar = page.locator('img[src^="https://www.gravatar.com/avatar/"]').first()
  await expect(avatar).toBeVisible()
  expect(await avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  expect(await violations()).toEqual([])
})

test('AC-SEC-05: the policy is enforced and the detector sees it: an inline script and a foreign image are blocked', async ({
  page,
}) => {
  const violations = await watchCsp(page)
  await page.goto('/projectsinfo')
  await expect(page.locator('#root > *').first()).toBeVisible()
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__inlineRan = true'
    document.body.append(script)
    const img = document.createElement('img')
    img.src = 'https://example.com/tracker.gif'
    document.body.append(img)
  })
  await expect.poll(async () => (await violations()).join('\n')).toMatch(/script-src/)
  await expect.poll(async () => (await violations()).join('\n')).toMatch(/img-src/)
  expect(await page.evaluate(() => window.__inlineRan)).toBeUndefined()
})
