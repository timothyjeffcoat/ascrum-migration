// AC-AWS-03: after a deploy, sign in as a seed user over HTTPS and load the projects list, on the real
// `demo` (CloudFront → ALB → ECS → RDS). Plus the production settings only a deployment can show: the
// cookies' flags behind TLS, the headers CloudFront sends, the reset route's absence, and that the load
// balancer does not answer anyone but CloudFront.
//
// The seed credentials are the public demo ones (web/stub/seed.ts, listed in the README); the database is
// created by this run and deleted with it.
import { expect, test } from '@playwright/test'
import { securityHeaders } from '../../web/securityHeaders.ts'
import { CREDENTIALS } from '../../web/stub/seed.ts'

const EVIDENCE = new URL('../evidence/', import.meta.url).pathname

test('AC-AWS-03: the demo is served over HTTPS, and plain HTTP redirects to it', async ({ request, baseURL }) => {
  const https = await request.get('/')
  expect(https.status()).toBe(200)
  expect(https.url()).toMatch(/^https:\/\//)
  const http = await request.get(`${baseURL?.replace(/^https:/, 'http:')}/`, { maxRedirects: 0 })
  expect(http.status()).toBe(301)
  expect(http.headers().location).toMatch(/^https:\/\//)
})

test('AC-AWS-03: signs in as a seed user over HTTPS and loads the projects list', async ({ page, context }) => {
  await page.goto('/projects')
  const modal = page.locator('.modal')
  await expect(modal.locator('.alert-warning')).toHaveText(
    'You must be logged in to access this part of the application.',
  )
  await modal.getByLabel('E-mail').fill(CREDENTIALS.dev1.email)
  await modal.getByLabel('Password').fill(CREDENTIALS.dev1.password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)

  // The seed's three projects, as AC-PRJ-01 expects them for dev1, now read from RDS.
  const table = page.locator('table.table.table-bordered.table-condensed.table-striped.table-hover')
  await expect(table.locator('tbody tr')).toHaveCount(3)
  await expect(table.getByRole('cell', { name: 'Webshop', exact: true })).toBeVisible()
  expect(new URL(page.url()).protocol).toBe('https:')
  await page.screenshot({ path: `${EVIDENCE}projects-signed-in.png`, fullPage: true })

  // AC-SEC-02 on the deployment: production cookies behind TLS.
  const cookies = await context.cookies()
  const sid = cookies.find((cookie) => cookie.name === 'sid')
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' })
  const xsrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
  expect(xsrf).toMatchObject({ httpOnly: false, secure: true, sameSite: 'Lax' })
})

test('AC-SEC-05 (deployed): the app and its assets carry web/securityHeaders.ts, plus HSTS', async ({ page }) => {
  const assets: Promise<Record<string, string>>[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/assets/')) assets.push(response.allHeaders())
  })
  for (const path of ['/', '/projectsinfo']) {
    const response = await page.goto(path)
    expect(response?.status(), path).toBe(200)
    const headers = (await response?.allHeaders()) ?? {}
    for (const [name, value] of Object.entries(securityHeaders)) {
      expect(headers[name.toLowerCase()], `${path}: ${name}`).toBe(value)
    }
    expect(headers['strict-transport-security'], path).toMatch(/^max-age=31536000/)
  }
  expect(assets.length).toBeGreaterThan(0)
  for (const headers of await Promise.all(assets)) {
    expect(headers['content-security-policy']).toBe(securityHeaders['Content-Security-Policy'])
    expect(headers['x-content-type-options']).toBe('nosniff')
  }
})

test('AC-SEC-03 (deployed): POST /__stub/reset answers 404', async ({ request }) => {
  expect((await request.post('/__stub/reset')).status()).toBe(404)
})

test('§3.6: the load balancer does not serve anyone but CloudFront', async () => {
  const alb = process.env.SMOKE_ALB_URL
  expect(alb, 'SMOKE_ALB_URL').toMatch(/^http:\/\//)
  // Its security group admits CloudFront's addresses only, so from here the connection is dropped (a
  // timeout); were it ever open, the listener would still answer 403 without the origin header.
  const outcome = await fetch(`${alb}/current-user`, { signal: AbortSignal.timeout(10_000) }).then(
    (response) => `HTTP ${response.status}`,
    (error: unknown) => `no connection (${error instanceof Error ? error.name : 'error'})`,
  )
  expect(outcome).toMatch(/^no connection|^HTTP 403$/)
})
