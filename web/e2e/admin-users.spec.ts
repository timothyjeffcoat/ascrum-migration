// Cluster 1 e2e: the admin-users screens (R16–R18) in a real browser, on `vite preview` + the Node stub.
import { expect, test, type Page } from '@playwright/test'

const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'

async function signIn(page: Page, email: string, password: string) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill(email)
  await modal.getByLabel('Password').fill(password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

/** Deep-links to the users list and signs in as the seeded admin when the guard asks. */
async function openUsersAsAdmin(page: Page) {
  await page.goto('/admin/users')
  await signIn(page, 'admin@abc.com', 'changeme')
  await expect(page).toHaveURL('/admin/users')
  const table = page.locator('table')
  await expect(table).toHaveAttribute('class', TABLE_CLASSES)
  return table
}

function rowFor(page: Page, email: string) {
  return page.locator('tbody tr').filter({ hasText: email })
}

test.describe('admin users', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-USR-01 / AC-USR-02 / AC-GRAV-01 / D8: the list, a row click to the edit form with empty passwords', async ({
    page,
  }) => {
    const table = await openUsersAsAdmin(page)
    await expect(table.locator('thead th')).toHaveText(['', 'E-mail', 'Last name', 'First name'])
    await expect(table.locator('tbody tr')).toHaveCount(6)
    const po = rowFor(page, 'po@ascrum.test')
    await expect(po.locator('td')).toHaveText(['', 'po@ascrum.test', 'Owner', 'Paula', 'Remove'])
    await expect(po.locator('img')).toHaveAttribute(
      'src',
      /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=50&d=monsterid$/,
    )

    await po.getByText('Owner', { exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f]{24}$/)
    await expect(page.locator('.well legend')).toHaveText('User')
    await expect(page.getByLabel('E-mail')).toHaveValue('po@ascrum.test')
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Password (repeat)')).toHaveValue('')
    await expect(page.locator('.well img.img-polaroid.pull-right')).toHaveAttribute('src', /\?s=200$/)
  })

  test('AC-USR-04 / AC-USR-07 / AC-USR-03: create a user, edit them, then remove them from the list', async ({
    page,
  }) => {
    await openUsersAsAdmin(page)
    await page.getByRole('button', { name: 'New User' }).click()
    await expect(page).toHaveURL('/admin/users/new')
    const save = page.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled()

    await page.getByLabel('E-mail').fill('po@ascrum.test')
    await expect(page.getByText('This email address is not available - please enter another.')).toBeVisible()
    await page.getByLabel('E-mail').fill('erin@ascrum.test')
    await page.getByLabel('Last name').fill('Example')
    await page.getByLabel('First name').fill('Erin')
    await page.getByLabel('Password', { exact: true }).fill('pw1')
    await page.getByLabel('Password (repeat)').fill('pw2')
    await expect(page.getByText('Passwords do not match.')).toHaveCount(2)
    await page.getByLabel('Password (repeat)').fill('pw1')
    await expect(save).toBeEnabled()
    await save.click()

    await expect(page).toHaveURL('/admin/users')
    await expect(page.locator('.alert-success')).toHaveText(/A user with id '[0-9a-f]{24}' was saved successfully\./)
    const erin = rowFor(page, 'erin@ascrum.test')
    await expect(erin.locator('td').nth(2)).toHaveText('Example')

    // Edit: blank passwords mean "unchanged" (AC-USR-06), so only the name changes.
    await erin.getByText('Example', { exact: true }).click()
    await page.getByLabel('Last name').fill('Sample')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL('/admin/users')
    await expect(rowFor(page, 'erin@ascrum.test').locator('td').nth(2)).toHaveText('Sample')

    // Remove from the list: no row navigation, the row goes, a notification shows.
    await rowFor(page, 'erin@ascrum.test').getByRole('button', { name: 'Remove' }).click()
    // The edit's "saved" notice is still there (current route); the removal adds its own.
    await expect(page.locator('.alert-success')).toHaveText([
      /A user with id '[0-9a-f]{24}' was saved successfully\./,
      /A user with id '[0-9a-f]{24}' was removed successfully\./,
    ])
    await expect(rowFor(page, 'erin@ascrum.test')).toHaveCount(0)
    await expect(page).toHaveURL('/admin/users')
  })

  test("D9 / AC-USR-07: a user's own e-mail is not taken; removing from the edit page returns to the list", async ({
    page,
  }) => {
    await openUsersAsAdmin(page)
    await rowFor(page, 'outsider@ascrum.test').getByText('Outsider', { exact: true }).click()
    await page.getByLabel('E-mail').fill('outsider@ascrum.tes')
    await page.getByLabel('E-mail').fill('outsider@ascrum.test')
    await page.getByLabel('First name').fill('Ottilie')
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
    await expect(page.getByText('This email address is not available - please enter another.')).toHaveCount(0)

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page).toHaveURL('/admin/users')
    await expect(page.locator('.alert-success')).toHaveText(/A user with id '[0-9a-f]{24}' was removed successfully\./)
    await expect(rowFor(page, 'outsider@ascrum.test')).toHaveCount(0)
  })
})
