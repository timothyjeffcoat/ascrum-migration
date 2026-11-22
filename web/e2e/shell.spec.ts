// Cluster 0 e2e: the shell, the login modal and deep links, in a real browser.
//   - "Node stub" tests: the production build on `vite preview` (base '/'), API proxied to the Node stub.
//   - "Pages build" tests: the GitHub Pages build (base '/ascrum-migration/', MSW in the browser), served
//     by scripts/pages-server.ts on PAGES_PORT (default 4174). They run in this file's project with a different baseURL;
//     no reset there, because the Pages build has no reset route and each page load is a fresh stub.
import { expect, test, type Page } from '@playwright/test'
import { probeStyles } from './support.ts'

async function signIn(page: Page, email: string, password: string) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill(email)
  await modal.getByLabel('Password').fill(password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

function breadcrumbs(page: Page) {
  return page.locator('ul.breadcrumb > li')
}

test.describe('shell on the Node stub', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-SHELL-06: an unknown path redirects to /projectsinfo', async ({ page }) => {
    await page.goto('/no/such/page')
    await expect(page).toHaveURL('/projectsinfo')
    await expect(breadcrumbs(page)).toHaveText(['/projectsinfo'])
  })

  test('AC-SHELL-07: the shell uses the legacy classes with Bootstrap 2 styles; a glyph icon resolves', async ({
    page,
    request,
  }) => {
    await page.goto('/projectsinfo')
    const navbarInner = page.locator('.navbar > .navbar-inner')
    await expect(navbarInner.locator('a.brand')).toHaveText('AScrum')
    await expect(page.locator('.navbar ul.breadcrumb')).toBeVisible()
    // Bootstrap 2.1.1's navbar: a vertical gradient (navbar.less #gradient > .vertical).
    const background = await navbarInner.evaluate((el) => getComputedStyle(el).backgroundImage)
    expect(background).toContain('linear-gradient')
    const { iconUrl } = await probeStyles(page)
    expect((await request.get(iconUrl)).status()).toBe(200)
  })

  test('AC-AUTH-09: reloading a guarded deep link while logged out shows the modal; logging in as admin completes the navigation', async ({
    page,
  }) => {
    await page.goto('/admin/users')
    await expect(page.locator('.modal .alert-warning')).toHaveText(
      'You must be logged in to access this part of the application.',
    )
    await expect(page.locator('a.brand')).toBeVisible() // the shell is there behind the modal

    await signIn(page, 'admin@abc.com', 'changeme')

    await expect(page).toHaveURL('/admin/users')
    await expect(breadcrumbs(page)).toHaveText(['/admin', '/users'])
    await expect(page.getByRole('button', { name: /Admin/ }).locator('xpath=..')).toHaveClass(/active/)
    await expect(page.getByRole('link', { name: 'Admin User' })).toBeVisible()

    // A reload keeps the session (real cookies through the proxy) and lands on the same page.
    await page.reload()
    await expect(breadcrumbs(page)).toHaveText(['/admin', '/users'])
    await expect(page.locator('.modal')).toHaveCount(0)
  })

  test('AC-AUTH-07 / AC-SHELL-01 / AC-SHELL-02: nav for a logged-in user, brand to /dashboard, logout to /', async ({
    page,
  }) => {
    await page.goto('/projectsinfo')
    await expect(page.getByRole('link', { name: 'My Projects' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.locator('.modal .alert-warning')).toHaveCount(0) // opened from the toolbar: no reason
    await signIn(page, 'po@ascrum.test', 'demo')

    await expect(page.getByRole('link', { name: 'Paula Owner' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'My Projects' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Admin/ })).toHaveCount(0)

    await page.locator('a.brand').click()
    await expect(page).toHaveURL('/dashboard')

    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL('/projectsinfo') // '/' then the legacy `otherwise`
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  })

  test('AC-AUTH-05: Cancel on a guarded deep link goes to / without an error', async ({ page }) => {
    await page.goto('/projects')
    await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL('/projectsinfo')
    await expect(page.locator('.alert')).toHaveCount(0)
  })

  test('AC-SHELL-05: the spinner image is served at its base-relative path', async ({ request }) => {
    expect((await request.get('/img/spinner.gif')).status()).toBe(200)
  })
})

test.describe('shell on the Pages build (base /ascrum-migration/, MSW)', () => {
  test.use({ baseURL: `http://localhost:${process.env.PAGES_PORT ?? '4174'}` })
  const BASE = '/ascrum-migration/'

  test('AC-SHELL-06 / AC-AUTH-09: a deep-link reload works under the Pages basename, through the login modal', async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}admin/users`)
    expect(response?.status()).toBe(404) // GitHub Pages serves 404.html, which is the app
    await signIn(page, 'admin@abc.com', 'changeme')
    await expect(page).toHaveURL(`${BASE}admin/users`)
    await expect(breadcrumbs(page)).toHaveText(['/admin', '/users'])
    // Links carry the basename; breadcrumb names stay the app paths.
    await expect(page.getByRole('link', { name: 'Current Projects' })).toHaveAttribute('href', `${BASE}projectsinfo`)
    await expect(page.locator('ul.breadcrumb a')).toHaveAttribute('href', `${BASE}admin`)
  })

  test('AC-SHELL-06: an unknown path under the basename redirects to /projectsinfo', async ({ page }) => {
    await page.goto(`${BASE}no/such/page`)
    await expect(page).toHaveURL(`${BASE}projectsinfo`)
  })

  test('AC-SHELL-05: the spinner image resolves under the basename', async ({ request }) => {
    expect((await request.get(`${BASE}img/spinner.gif`)).status()).toBe(200)
  })
})
