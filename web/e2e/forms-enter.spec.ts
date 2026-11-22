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
