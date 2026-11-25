// DSC-1 / DSC-2 (legacy audit, wave A) and spec §0.2 P4: what Enter does inside a form, in a real browser
// on `vite preview` + the Node stub. jsdom does not navigate on a native form submission, so the
// reload in DSC-1 can only be reproduced here.
import { expect, test, type Page } from '@playwright/test'

const DEV1 = 'Developer Dana (dev1@ascrum.test)'
const DEV2 = 'Coder Devon (dev2@ascrum.test)'

async function fillAdminLogin(page: Page) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill('admin@abc.com')
  await modal.getByLabel('Password').fill('changeme')
  return modal
}

test.describe('Enter in forms (P4)', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-AUTH-04 / DSC-2 / P4: Enter in the password field signs in', async ({ page }) => {
    await page.goto('/admin/projects')
    const modal = await fillAdminLogin(page)
    await modal.getByLabel('Password').press('Enter')
    await expect(modal).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Admin User' })).toBeVisible()
  })

  // P7 / DEV-owner-04: the jsdom test in src/auth/LoginModal.test.tsx submits twice in one tick. Here the
  // reply to the first POST /login is held open in a real browser, the slow reply legacy got wrong.
  // No fixed sleeps: the reply is released only after the second Enter and a sentinel request have
  // both reached the route. A second POST would be issued synchronously by the second Enter's submit
  // handler, before the sentinel, so the sentinel's arrival proves it had its chance to show up.
  // Chromium project only: the `pages` project matches e2e/pages/ alone, and there MSW answers in the
  // service worker, where page.route does not see the requests (see the fix-slow-login worklog).
  test('P7 / DEV-owner-04: Enter twice while the sign-in reply is held sends one POST /login', async ({ page }) => {
    const SENTINEL = 'e2e-p7-sentinel'
    let loginPosts = 0
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let firstPostSeen!: () => void
    const firstPost = new Promise<void>((resolve) => (firstPostSeen = resolve))

    await page.route(
      (url) => url.pathname === '/login',
      async (route) => {
        const request = route.request()
        if (new URL(request.url()).searchParams.has(SENTINEL)) {
          await route.fulfill({ status: 204 })
          return
        }
        if (request.method() !== 'POST') {
          await route.fallback()
          return
        }
        loginPosts += 1 // counted before any await, in the order the browser sent them
        firstPostSeen()
        await released
        await route.continue() // the real stub answers
      },
    )

    await page.goto('/admin/projects')
    const modal = await fillAdminLogin(page)
    const password = modal.getByLabel('Password')
    await password.press('Enter')
    await firstPost
    await password.press('Enter')
    // Issued after the second Enter was handled; when it has reached the route, so has any second POST.
    await page.evaluate(async (sentinel) => {
      await fetch(`/login?${sentinel}`)
    }, SENTINEL)

    expect(loginPosts).toBe(1)
    await expect(modal).toBeVisible()
    await expect(modal.locator('.alert-error')).toHaveCount(0)

    release()
    await expect(modal).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Admin User' })).toBeVisible()
    await expect(page.locator('.alert-error')).toHaveCount(0)
    expect(loginPosts).toBe(1)
  })

  test('DSC-1 / P4: Enter in the project Name field keeps the edits and does not reload the page', async ({ page }) => {
    await page.goto('/admin/projects')
    const modal = await fillAdminLogin(page)
    await modal.getByRole('button', { name: 'Sign in' }).click()
    await expect(modal).toHaveCount(0)
    await page.getByText('Webshop', { exact: true }).click()
    const name = page.getByLabel('Name')
    await expect(name).toHaveValue('Webshop')
    const editUrl = page.url()

    // A native submission is a document request; none may happen.
    const documentRequests: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentRequests.push(request.url())
    })
    await name.fill('Renamed but unsaved')
    await name.press('Enter')

    await expect(name).toHaveValue('Renamed but unsaved')
    expect(page.url()).toBe(editUrl)
    expect(page.url()).not.toContain('?name=')
    expect(documentRequests).toEqual([])
    // Legacy clicked the first team "Remove" on Enter; that bug is not ported.
    await expect(
      page
        .locator('table', { has: page.getByRole('columnheader', { name: 'User' }) })
        .locator('tbody tr:not(:last-child) td:first-child'),
    ).toHaveText([DEV1, DEV2])
  })
})
