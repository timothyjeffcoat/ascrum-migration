// Cluster 2 e2e: the admin projects screens (/admin/projects, /new, /:itemId) in a real browser,
// on `vite preview` + the Node stub.
import { expect, test, type Locator, type Page } from '@playwright/test'

const PO = 'Owner Paula (po@ascrum.test)'
const SM = 'Master Sam (sm@ascrum.test)'
const DEV1 = 'Developer Dana (dev1@ascrum.test)'
const OUTSIDER = 'Outsider Otto (outsider@ascrum.test)'

async function signInAsAdmin(page: Page) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill('admin@abc.com')
  await modal.getByLabel('Password').fill('changeme')
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

function listTable(page: Page): Locator {
  return page.locator('table', { has: page.getByRole('columnheader', { name: 'Description' }) })
}

function devTeamTable(page: Page): Locator {
  return page.locator('table', { has: page.getByRole('columnheader', { name: 'User' }) })
}

test.describe('admin projects on the Node stub', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-APR-01: the guarded list loads after an admin login and opens a project for editing', async ({ page }) => {
    await page.goto('/admin/projects')
    await signInAsAdmin(page)

    const table = listTable(page)
    await expect(table).toHaveClass('table table-bordered table-condensed table-striped table-hover')
    await expect(table.locator('tbody tr td:first-child')).toHaveText(['Webshop', 'Mobile App', 'Legacy Cleanup'])
    await expect(page.locator('.well > button.btn', { hasText: 'New Project' })).toBeVisible()

    await table.getByText('Webshop', { exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/projects\/[0-9a-f]{24}$/)
    await expect(page.getByLabel('Name')).toHaveValue('Webshop')
    await expect(devTeamTable(page).locator('tbody tr:not(:last-child) td:first-child')).toHaveText([
      DEV1,
      'Coder Devon (dev2@ascrum.test)',
    ])
  })

  test('AC-APR-02..06 / D21: create a project with a team, then edit and remove it', async ({ page }) => {
    await page.goto('/admin/projects')
    await signInAsAdmin(page)
    await page.getByRole('button', { name: 'New Project' }).click()
    await expect(page).toHaveURL('/admin/projects/new')

    const save = page.locator('button.save')
    await expect(page.locator('.well > form legend')).toHaveText('Project')
    await page.getByLabel('Name').fill('Intranet')
    await page.getByLabel('Description').fill('New intranet')
    await page.getByLabel('Product Owner').selectOption({ label: PO })
    await expect(save).toBeDisabled() // the Scrum Master is required
    await page.getByLabel('Scrum Master').selectOption({ label: SM })

    const team = devTeamTable(page)
    const add = team.getByRole('button', { name: 'Add' })
    await expect(add).toBeDisabled()
    await team.getByRole('combobox').selectOption({ label: DEV1 })
    await add.click()
    await team.getByRole('combobox').selectOption({ label: OUTSIDER })
    await add.click()
    await expect(team.getByRole('combobox')).toHaveValue('')
    // A developer is no longer a Product Owner candidate (AC-APR-05).
    await expect(page.getByLabel('Product Owner').locator('option')).not.toContainText([DEV1])

    await save.click()
    await expect(page).toHaveURL('/admin/projects')
    await expect(page.locator('.alert.alert-success')).toHaveText(
      /^x\s*A project with id '[0-9a-f]{24}' was saved successfully\.$/,
    )
    await listTable(page).getByText('Intranet', { exact: true }).click()

    // Remove a team member, save again.
    await expect(team.locator('tbody tr:not(:last-child) td:first-child')).toHaveText([DEV1, OUTSIDER])
    await team.locator('tr', { hasText: DEV1 }).getByRole('button', { name: 'Remove' }).click()
    await save.click()
    await expect(page).toHaveURL('/admin/projects')
    await listTable(page).getByText('Intranet', { exact: true }).click()
    await expect(team.locator('tbody tr:not(:last-child) td:first-child')).toHaveText([OUTSIDER])

    // D21: removing says "removed".
    await page.locator('button.btn-danger.remove').click()
    await expect(page).toHaveURL('/admin/projects')
    await expect(page.locator('.alert.alert-success')).toContainText('was removed successfully.')
    await expect(listTable(page).getByText('Intranet', { exact: true })).toHaveCount(0)
  })
})
