// Phase 2 risk proofs for the GitHub Pages build (spec §11-2, §11-3, §11-6, AC-STUB-14), served by
// scripts/pages-server.ts, which mimics Pages: /ascrum-migration/ base, 404.html for unknown paths.
import { expect, test } from '@playwright/test'
import { bootApp, probeStyles } from '../support.ts'

const BASE = '/ascrum-migration/'

test('§11-3: a deep link gets 404.html, which boots the SPA at the same URL', async ({ page }) => {
  const response = await bootApp(page, `${BASE}projects/123/productbacklog`)
  expect(response?.status()).toBe(404) // what GitHub Pages really answers
  expect(new URL(page.url()).pathname).toBe(`${BASE}projects/123/productbacklog`)
})

test('§11-6: CSS asset urls carry the /ascrum-migration/ base', async ({ page, request }) => {
  await bootApp(page, BASE)
  const { iconUrl, paragraphMarginBottom } = await probeStyles(page)
  expect(new URL(iconUrl).pathname).toBe(`${BASE}img/glyphicons-halflings.png`)
  expect((await request.get(iconUrl)).status()).toBe(200)
  expect(paragraphMarginBottom).toBe('10px')
})

test('§11-2: the in-browser stub works: XSRF cookie reaches document.cookie, login round-trips', async ({ page }) => {
  await bootApp(page, `${BASE}projects`)
  const result = await page.evaluate(async () => {
    const strip = async (r: Response) => JSON.parse((await r.text()).slice(")]}',\n".length)) as unknown
    const token = () => decodeURIComponent(/XSRF-TOKEN=([^;]*)/.exec(document.cookie)?.[1] ?? '')
    const anonymous = await strip(await fetch('/current-user'))
    const cookieAfterGet = document.cookie
    const body = JSON.stringify({ email: 'po@ascrum.test', password: 'demo' })
    const forbidden = await fetch('/login', { method: 'POST', body })
    const ok = await strip(await fetch('/login', { method: 'POST', headers: { 'X-XSRF-TOKEN': token() }, body }))
    const me = await strip(await fetch('/current-user'))
    const projects = (await strip(await fetch('/databases/ascrum/collections/projects'))) as unknown[]
    return { anonymous, cookieAfterGet, forbidden: forbidden.status, ok, me, projectCount: projects.length }
  })
  expect(result.anonymous).toEqual({ user: null })
  expect(result.cookieAfterGet).toMatch(/XSRF-TOKEN=/)
  expect(result.forbidden).toBe(403)
  expect(result.ok).toMatchObject({ user: { email: 'po@ascrum.test' } })
  expect(result.me).toMatchObject({ user: { email: 'po@ascrum.test' } })
  expect(result.projectCount).toBe(3)
})

test('AC-STUB-14: /__stub/reset does not exist in the Pages build', async ({ page }) => {
  await bootApp(page, BASE)
  const status = await page.evaluate(async () => {
    const token = decodeURIComponent(/XSRF-TOKEN=([^;]*)/.exec(document.cookie)?.[1] ?? '')
    return (await fetch('/__stub/reset', { method: 'POST', headers: { 'X-XSRF-TOKEN': token } })).status
  })
  expect(status).toBe(404) // not intercepted: falls through to the (Pages-like) network
})
