// Phase 2 risk proofs against the production build + Node stub (spec §11-1, §11-6; §7 through a real
// browser and the Vite proxy). Independent of app markup, so cluster 0 can replace the placeholder.
import { expect, test } from '@playwright/test'
import { bootApp, probeStyles } from './support.ts'

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__stub/reset')).status()).toBe(204)
})

test('§11-1: Bootstrap 2 LESS compiles with math:always (division is evaluated)', async ({ page }) => {
  await bootApp(page, '/')
  const styles = await probeStyles(page)
  expect(styles.paragraphMarginBottom).toBe('10px') // type.less: margin: 0 0 @baseLineHeight / 2
  expect(styles.closeOpacity).toBe('0.2') // mixins.less .opacity(20): opacity: @opacity / 100
})

test('§11-6: the glyph sprite path resolves at base "/"', async ({ page, request }) => {
  await bootApp(page, '/')
  const { iconUrl } = await probeStyles(page)
  expect(new URL(iconUrl).pathname).toBe('/img/glyphicons-halflings.png')
  expect((await request.get(iconUrl)).status()).toBe(200)
  expect((await request.get('/img/spinner.gif')).status()).toBe(200)
})

test('deep links serve the SPA from vite preview', async ({ page }) => {
  await bootApp(page, '/projects/123/sprints')
  expect(new URL(page.url()).pathname).toBe('/projects/123/sprints')
})

test('stub through the proxy: real cookies, XSRF 403, login and logout', async ({ page }) => {
  await bootApp(page, '/')
  const result = await page.evaluate(async () => {
    const strip = async (r: Response) => JSON.parse((await r.text()).slice(")]}',\n".length)) as unknown
    const token = () => decodeURIComponent(/XSRF-TOKEN=([^;]*)/.exec(document.cookie)?.[1] ?? '')
    const login = (headers: Record<string, string>) =>
      fetch('/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'admin@abc.com', password: 'changeme' }),
      })
    const anonymous = await strip(await fetch('/current-user'))
    const forbidden = await login({})
    const ok = await strip(await login({ 'X-XSRF-TOKEN': token() }))
    const me = await strip(await fetch('/current-user'))
    const logout = await fetch('/logout', { method: 'POST', headers: { 'X-XSRF-TOKEN': token() } })
    return { anonymous, forbidden: [forbidden.status, await forbidden.text()], ok, me, logout: logout.status }
  })
  expect(result.anonymous).toEqual({ user: null })
  expect(result.forbidden).toEqual([403, 'Forbidden'])
  expect(result.ok).toMatchObject({ user: { email: 'admin@abc.com', admin: true } })
  expect(result.me).toMatchObject({ user: { email: 'admin@abc.com' } })
  expect(result.logout).toBe(204)
  // The session cookie is HttpOnly on the real server: script can't see it.
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/sid=/)
})
