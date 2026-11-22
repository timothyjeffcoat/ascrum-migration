// Cluster 5 e2e: /projectsinfo and /dashboard on the production build + Node stub.
import { expect, test, type Page } from '@playwright/test'
import { PROJECT } from '../stub/seed.ts'

async function signIn(page: Page, email: string, password: string) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill(email)
  await modal.getByLabel('Password').fill(password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

const LEGACY_TABLE = 'table.table.table-bordered.table-condensed.table-striped.table-hover'

test.describe('dashboard and projects info on the Node stub', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-PIN-01 / D1: /projectsinfo is public, fetches the projects and shows only its heading', async ({ page }) => {
    const projectsRequest = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/collections/projects'))
    await page.goto('/projectsinfo')
    await projectsRequest
    await expect(page.getByRole('heading', { name: 'Projects info', level: 3 })).toBeVisible()
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(page.locator('table')).toHaveCount(0)
    await expect(page.getByText('Webshop')).toHaveCount(0)
  })

  test('AC-DSH-01 / D4 / D3: /dashboard asks for a login, then shows all projects with my roles and working links, and all tasks', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    await expect(page.locator('.modal .alert-warning')).toHaveText(
      'You must be logged in to access this part of the application.',
    )
    await signIn(page, 'sm@ascrum.test', 'demo')

    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByRole('heading', { name: 'My projects', level: 4 })).toBeVisible()
    const [projectsTable, tasksTable] = [page.locator(LEGACY_TABLE).nth(0), page.locator(LEGACY_TABLE).nth(1)]
    await expect(projectsTable.locator('tbody tr')).toHaveCount(3)
    const webshop = projectsTable.locator('tbody tr', {
      has: page.getByRole('cell', { name: 'Webshop', exact: true }),
    })
    await expect(webshop.locator('td').nth(2)).toHaveText('SM')
    await expect(projectsTable.locator('tbody tr', { hasText: 'Mobile App' }).locator('td').nth(2)).toHaveText('PO')

    await expect(page.getByRole('heading', { name: 'My tasks', level: 4 })).toBeVisible()
    await expect(tasksTable.locator('tbody tr')).toHaveCount(12)
    await expect(tasksTable.locator('tbody tr', { hasText: 'Cart UI' }).locator('td')).toHaveText([
      'Cart UI',
      '5',
      '5',
      '',
    ])

    // D3: legacy navigated to /projects/[object Object]/sprints.
    await webshop.getByText('Sprints').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT.webshop}/sprints$`))
    await page.goBack()
    await webshop.getByText('Product backlog').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT.webshop}/productbacklog$`))
  })

  test('AC-DSH-01: the brand link takes a signed-in user without any project role to the dashboard', async ({
    page,
  }) => {
    await page.goto('/projectsinfo')
    await page.getByRole('button', { name: 'Log in' }).click()
    await signIn(page, 'outsider@ascrum.test', 'demo')
    await page.locator('a.brand').click()
    await expect(page).toHaveURL('/dashboard')
    const projectsTable = page.locator(LEGACY_TABLE).nth(0)
    await expect(projectsTable.locator('tbody tr')).toHaveCount(3)
    await expect(projectsTable.locator('tbody tr td:nth-child(3)')).toHaveText(['', '', ''])
    await expect(page.locator(LEGACY_TABLE).nth(1).locator('tbody tr')).toHaveCount(12)
  })
})
