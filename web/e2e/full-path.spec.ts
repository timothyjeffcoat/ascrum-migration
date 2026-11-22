// AC-E2E-FULL (spec §8.1, §12.4): the whole AScrum path in one browser session, against the Node stub:
// admin login → create a project with a team → a backlog item → a sprint holding that item → a task →
// logout. Every step goes through the UI; only the reset at the start talks to the stub directly.
import { expect, test, type Page } from '@playwright/test'

const PO = 'Owner Paula (po@ascrum.test)'
const SM = 'Master Sam (sm@ascrum.test)'
const DEV1 = 'Developer Dana (dev1@ascrum.test)'
const ID = '[0-9a-f]{24}'

async function signInAsAdmin(page: Page) {
  await page.getByRole('button', { name: 'Log in' }).click()
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await modal.getByLabel('E-mail').fill('admin@abc.com')
  await modal.getByLabel('Password').fill('changeme')
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByText('Admin User')).toBeVisible()
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__stub/reset')).status()).toBe(204)
})

test('AC-E2E-FULL: admin login → project with team → backlog item → sprint with the item → task → logout', async ({
  page,
}) => {
  await page.goto('/projectsinfo')
  await signInAsAdmin(page)

  // 1. Project with a team (Admin → Manage Projects → New Project).
  await page.getByRole('button', { name: 'Admin' }).click()
  await page.getByRole('link', { name: 'Manage Projects' }).click()
  await expect(page).toHaveURL('/admin/projects')
  await page.getByRole('button', { name: 'New Project' }).click()
  await page.getByLabel('Name').fill('Full Path')
  await page.getByLabel('Description').fill('Created end to end')
  await page.getByLabel('Product Owner').selectOption({ label: PO })
  await page.getByLabel('Scrum Master').selectOption({ label: SM })
  const team = page.locator('table', { has: page.getByRole('columnheader', { name: 'User' }) })
  await team.getByRole('combobox').selectOption({ label: DEV1 })
  await team.getByRole('button', { name: 'Add' }).click()
  await page.locator('button.save').click()
  await expect(page).toHaveURL('/admin/projects')
  await expect(page.locator('.alert.alert-success')).toContainText('was saved successfully.')

  // 2. Backlog item (My Projects → Product backlog → New backlog item).
  await page.getByRole('link', { name: 'My Projects' }).click()
  await expect(page).toHaveURL('/projects')
  const project = page.locator('tr', { has: page.getByRole('cell', { name: 'Full Path', exact: true }) })
  await project.getByText('Product backlog').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${ID}/productbacklog$`))
  const projectPath = new URL(page.url()).pathname.replace(/\/productbacklog$/, '')
  await expect(page.getByText('No items in the backlog')).toBeVisible()
  await page.getByRole('button', { name: 'New backlog item' }).click()
  await page.getByLabel('Name').fill('Sign-up page')
  await page.getByLabel('User story').fill('Visitors can create an account')
  await page.getByLabel('Priority').fill('1')
  await page.getByLabel('Estimation').fill('5')
  await page.locator('button.save').click()
  await expect(page).toHaveURL(`${projectPath}/productbacklog`)
  await expect(page.getByRole('cell', { name: 'Sign-up page' })).toBeVisible()

  // 3. Sprint holding the item (My Projects → Sprints → New sprint → Add to sprint).
  await page.getByRole('link', { name: 'My Projects' }).click()
  await project.getByText('Sprints').click()
  await expect(page).toHaveURL(`${projectPath}/sprints`)
  await expect(page.getByText('No sprints defined')).toBeVisible()
  await page.getByRole('button', { name: 'New sprint' }).click()
  await page.getByLabel('Name').fill('Sprint A')
  await page.getByLabel('Capacity').fill('10')
  await page.getByLabel('Start date').fill('2026-12-01')
  await page.getByLabel('End date').fill('2026-12-12')
  await page.locator('tr', { hasText: 'Sign-up page' }).getByRole('button', { name: 'Add to sprint' }).click()
  const inSprint = page.locator('label', { hasText: "Currently in the sprint's backlog" })
  const sprintTable = inSprint.locator('xpath=following-sibling::table[1]')
  await expect(sprintTable.locator('tbody td:first-child')).toHaveText(['Sign-up page'])
  await expect(sprintTable.locator('tfoot td').nth(1)).toHaveText('5')
  await page.locator('button.save').click()
  await expect(page).toHaveURL(`${projectPath}/sprints`)

  // 4. Task (Tasks → New task).
  await page.locator('tr', { hasText: 'Sprint A' }).getByRole('button', { name: 'Tasks' }).click()
  await expect(page).toHaveURL(new RegExp(`^[^?]*${projectPath}/sprints/${ID}/tasks$`))
  const tasksPath = new URL(page.url()).pathname
  await expect(page.getByText('No tasks defined for this sprint')).toBeVisible()
  await page.getByRole('button', { name: 'New task' }).click()
  await page.getByLabel('Name').fill('Sign-up form')
  await page.getByLabel('Product Backlog item').selectOption({ label: 'Sign-up page' })
  await page.getByLabel('Description').fill('Fields, validation and submit')
  await page.getByLabel('Estimation').fill('3')
  await page.getByLabel('Remaining').fill('3')
  await expect(page.getByLabel('Assigned to').locator('option')).toHaveText(['-- unassigned --', DEV1])
  await page.getByLabel('Assigned to').selectOption({ label: DEV1 })
  await page.locator('button.save').click()
  await expect(page).toHaveURL(tasksPath) // D6
  await expect(page.locator('tr', { hasText: 'Sign-up form' }).locator('td')).toHaveText(['Sign-up form', '3', '3', ''])
  // DEV-sprints-tasks-02: reopen the task to prove the assignee (and backlog item) were saved, not only picked.
  await page.getByRole('cell', { name: 'Sign-up form', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`^[^?]*${tasksPath}/${ID}$`))
  await expect(page.getByLabel('Name')).toHaveValue('Sign-up form')
  await expect(page.getByLabel('Product Backlog item').locator('option:checked')).toHaveText('Sign-up page')
  await expect(page.getByLabel('Assigned to').locator('option:checked')).toHaveText(DEV1)

  // 5. Logout.
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL('/projectsinfo')
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'My Projects' })).toHaveCount(0)
})
