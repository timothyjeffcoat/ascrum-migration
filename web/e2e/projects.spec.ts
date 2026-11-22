// Cluster 3 e2e: /projects and the product backlog screens on the production build + Node stub.
import { expect, test, type Page } from '@playwright/test'
import { PROJECT } from '../stub/seed.ts'

const webshopId = PROJECT.webshop

async function signIn(page: Page, email: string, password: string) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill(email)
  await modal.getByLabel('Password').fill(password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

test.describe('projects and product backlog on the Node stub', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-PRJ-01: /projects deep link asks for a login, then lists the projects with my roles and links', async ({
    page,
  }) => {
    await page.goto('/projects')
    await expect(page.locator('.modal .alert-warning')).toHaveText(
      'You must be logged in to access this part of the application.',
    )
    await signIn(page, 'dev1@ascrum.test', 'demo')

    const table = page.locator('table.table.table-bordered.table-condensed.table-striped.table-hover')
    await expect(table.locator('tbody tr')).toHaveCount(3)
    // Exact cell match: Mobile App's description also mentions "the webshop".
    const webshop = table.locator('tbody tr', { has: page.getByRole('cell', { name: 'Webshop', exact: true }) })
    await expect(webshop.locator('td')).toHaveText([
      'Webshop',
      'Online store rewrite',
      'DEV',
      /Product backlog\s+Sprints/,
    ])
    await expect(table.locator('tbody tr', { hasText: 'Mobile App' }).locator('td').nth(2)).toHaveText('SM')

    await webshop.getByText('Sprints').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${webshopId}/sprints$`))
    await page.goBack()
    await webshop.getByText('Online store rewrite').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${webshopId}/productbacklog$`))
  })

  test('AC-PBL-01..03: create, edit and remove a backlog item', async ({ page }) => {
    await page.goto(`/projects/${webshopId}/productbacklog`)
    await signIn(page, 'po@ascrum.test', 'demo')

    const rows = page.locator('table tbody tr')
    await expect(rows).toHaveCount(6)
    await expect(page.locator('.well > button.btn')).toHaveText('New backlog item')

    // Create
    await page.getByRole('button', { name: 'New backlog item' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${webshopId}/productbacklog/new$`))
    const form = page.locator('.well form')
    const save = form.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled()
    await form.getByLabel('Name').fill('Gift cards')
    await form.getByLabel('User story').fill('Customers can buy gift cards')
    await form.getByLabel('Priority').fill('7')
    await expect(save).toBeDisabled() // Estimation is still missing
    await form.getByLabel('Estimation').fill('8')
    await save.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${webshopId}/productbacklog$`))
    await expect(rows).toHaveCount(7)
    await expect(rows.filter({ hasText: 'Gift cards' }).locator('td')).toHaveText([
      'Gift cards',
      'Customers can buy gift cards',
      '7',
      '8',
    ])

    // Edit
    await rows.filter({ hasText: 'Gift cards' }).click()
    await expect(form.getByLabel('Name')).toHaveValue('Gift cards')
    await form.getByLabel('Estimation').fill('5')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(rows.filter({ hasText: 'Gift cards' }).locator('td').nth(3)).toHaveText('5')

    // Remove
    await rows.filter({ hasText: 'Gift cards' }).click()
    await form.getByRole('button', { name: 'Remove' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${webshopId}/productbacklog$`))
    await expect(rows).toHaveCount(6)
    await expect(rows.filter({ hasText: 'Gift cards' })).toHaveCount(0)
  })
})
