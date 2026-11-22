// Cluster 4 e2e: the sprints and tasks screens (R7–R12) in a real browser, on `vite preview` + the
// Node stub.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PROJECT, SPRINT } from '../stub/seed.ts'

const sprintsPath = `/projects/${PROJECT.webshop}/sprints`
const sprint1TasksPath = `${sprintsPath}/${SPRINT.webshop1}/tasks`
const DEV2 = 'Coder Devon (dev2@ascrum.test)'
const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'

async function signIn(page: Page, email: string, password: string) {
  const modal = page.locator('.modal')
  await expect(modal.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(modal.locator('.alert-warning')).toHaveText(
    'You must be logged in to access this part of the application.',
  )
  await modal.getByLabel('E-mail').fill(email)
  await modal.getByLabel('Password').fill(password)
  await modal.getByRole('button', { name: 'Sign in' }).click()
  await expect(modal).toHaveCount(0)
}

/** The table after one of the sprint picker's captions. */
function pickerTable(page: Page, caption: string): Locator {
  return page.locator('label', { hasText: caption }).locator('xpath=following-sibling::table[1]')
}

test.describe('sprints and tasks on the Node stub', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/__stub/reset')).status()).toBe(204)
  })

  test('AC-SPR-01..05 / D13: the guarded sprint list, the backlog picker, save and remove', async ({ page }) => {
    await page.goto(sprintsPath)
    await signIn(page, 'sm@ascrum.test', 'demo')

    const list = page.locator('table', { has: page.getByRole('columnheader', { name: 'Start date' }) })
    await expect(list).toHaveClass(TABLE_CLASSES)
    await expect(list.locator('tbody tr').first().locator('td')).toHaveText([
      'Sprint 1',
      '2026-11-02',
      '2026-11-13',
      'ACTIVE',
      'Tasks',
    ])

    // Edit Sprint 1: it references a deleted backlog item (D13).
    await list.getByText('Sprint 1').click()
    await expect(page).toHaveURL(`${sprintsPath}/${SPRINT.webshop1}`)
    await expect(page.locator('.well > h4').first()).toHaveText('Sprint')
    const left = pickerTable(page, "Currently in the sprint's backlog")
    const right = pickerTable(page, 'Product backlog')
    await expect(left.locator('tbody tr td:first-child')).toHaveText(['Product catalogue', 'Shopping cart', ''])
    await expect(left.locator('tfoot td')).toHaveText(['Estimation in total', '13', '-'])

    // Drop the dangling id, add Search; the total follows.
    await left.locator('tbody tr').nth(2).getByRole('button', { name: 'Remove' }).click()
    await right.locator('tr', { hasText: 'Search' }).getByRole('button', { name: 'Add to sprint' }).click()
    await expect(left.locator('tbody tr td:first-child')).toHaveText(['Product catalogue', 'Shopping cart', 'Search'])
    await expect(left.locator('tfoot td').nth(1)).toHaveText('21')
    await expect(right.getByText('Search')).toHaveCount(0)
    await page.getByLabel('Capacity').fill('25')
    await page.locator('button.save').click()
    await expect(page).toHaveURL(sprintsPath)

    await list.getByText('Sprint 1').click()
    await expect(page.getByLabel('Capacity')).toHaveValue('25')
    await expect(left.locator('tfoot td').nth(1)).toHaveText('21')

    // A new sprint, then remove it.
    await page.goto(sprintsPath)
    await page.getByRole('button', { name: 'New sprint' }).click()
    await expect(page).toHaveURL(`${sprintsPath}/new`)
    await page.getByLabel('Name').fill('Sprint 3')
    await page.getByLabel('Capacity').fill('10')
    await page.getByLabel('Start date').fill('2026-11-30')
    await page.getByLabel('End date').fill('2026-12-11')
    await page.locator('button.save').click()
    await expect(page).toHaveURL(sprintsPath)
    await expect(list.locator('tbody tr')).toHaveCount(3)
    await list.getByText('Sprint 3').click()
    await page.locator('button.remove').click()
    await expect(page).toHaveURL(sprintsPath)
    await expect(list.locator('tbody tr')).toHaveCount(2)
  })

  test('AC-SPR-03: a backlog item name in the picker opens the backlog item', async ({ page }) => {
    await page.goto(`${sprintsPath}/${SPRINT.webshop2}`)
    await signIn(page, 'po@ascrum.test', 'demo')
    await pickerTable(page, "Currently in the sprint's backlog").getByText('Checkout').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT.webshop}/productbacklog/[0-9a-f]{24}$`))
    await expect(page.getByLabel('Name')).toHaveValue('Checkout')
  })

  test('AC-TSK-01..03 / D6 / S13: the task list, create, edit (reassign) and remove', async ({ page }) => {
    await page.goto(sprintsPath)
    await signIn(page, 'dev1@ascrum.test', 'demo')
    await page.locator('tr', { hasText: 'Sprint 1' }).getByRole('button', { name: 'Tasks' }).click()
    await expect(page).toHaveURL(sprint1TasksPath)

    const list = page.locator('table', { has: page.getByRole('columnheader', { name: 'Remaining' }) })
    await expect(list).toHaveClass(TABLE_CLASSES)
    await expect(list.locator('tbody tr')).toHaveCount(7)

    // Create
    await page.getByRole('button', { name: 'New task' }).click()
    await expect(page).toHaveURL(`${sprint1TasksPath}/new`)
    await expect(page.getByLabel('State')).toHaveValue('TODO')
    const save = page.locator('button.save')
    await page.getByLabel('Name').fill('Cart badge')
    await page.getByLabel('Product Backlog item').selectOption({ label: 'Shopping cart' })
    await page.getByLabel('Description').fill('Item count on the cart icon')
    await page.getByLabel('Estimation').fill('2')
    await expect(save).toBeDisabled() // Remaining is still missing
    await page.getByLabel('Remaining').fill('2')
    await page.getByLabel('Assigned to').selectOption({ label: DEV2 })
    await save.click()
    // D6: legacy went to /admin/users.
    await expect(page).toHaveURL(sprint1TasksPath)
    await expect(list.locator('tr', { hasText: 'Cart badge' }).locator('td')).toHaveText(['Cart badge', '2', '2', ''])

    // Edit: progress it and unassign it (S13).
    await list.getByText('Cart badge').click()
    await expect(page.getByLabel('Assigned to')).toHaveValue(/^[0-9a-f]{24}$/)
    await page.getByLabel('Remaining').fill('1')
    await page.getByLabel('State').selectOption('IN_DEV')
    await page.getByLabel('Assigned to').selectOption({ label: '-- unassigned --' })
    await save.click()
    await expect(page).toHaveURL(sprint1TasksPath)
    await list.getByText('Cart badge').click()
    await expect(page.getByLabel('State')).toHaveValue('IN_DEV')
    await expect(page.getByLabel('Assigned to')).toHaveValue('')

    // Remove
    await page.locator('button.remove').click()
    await expect(page).toHaveURL(sprint1TasksPath)
    await expect(list.locator('tbody tr')).toHaveCount(7)
    await expect(list.getByText('Cart badge')).toHaveCount(0)
  })

  test('AC-TSK-02 / P5 / Q-sprints-tasks-3: a malformed stored state shows -- choose --, and TODO can be picked', async ({
    page,
  }) => {
    await page.goto(sprint1TasksPath)
    await signIn(page, 'dev1@ascrum.test', 'demo')

    // Seed the malformed state through the stub's own API with the page's session (the UI cannot make one).
    const tasksUrl = '/databases/ascrum/collections/tasks'
    const found = await page.request.get(tasksUrl, { params: { q: JSON.stringify({ name: 'Design catalogue page' }) } })
    const [{ _id: oid, ...task }] = (await found.json()) as [{ _id: { $oid: string } } & Record<string, unknown>]
    expect((await page.request.put(`${tasksUrl}/${oid.$oid}`, { data: { ...task, state: 'WAITING' } })).ok()).toBe(true)

    await page.goto(`${sprint1TasksPath}/${oid.$oid}`)
    const state = page.getByLabel('State')
    await expect(state).toHaveValue('')
    await expect(state.locator('option:checked')).toHaveText('-- choose --')
    const save = page.locator('button.save')
    await expect(save).toBeDisabled()

    // Without the blank option the browser showed TODO already, and picking it changed nothing.
    await state.selectOption('TODO')
    await expect(state).toHaveValue('TODO')
    await expect(state.locator('option')).toHaveText(['TODO', 'IN_DEV', 'BLOCKED', 'IN_TEST', 'DONE'])
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page).toHaveURL(sprint1TasksPath)
    await page.getByText('Design catalogue page').click()
    await expect(page.getByLabel('State')).toHaveValue('TODO')
  })

  test('P4: Enter in the sprint and task forms keeps the edits and does not reload the page', async ({ page }) => {
    await page.goto(`${sprintsPath}/${SPRINT.webshop1}`)
    await signIn(page, 'dev1@ascrum.test', 'demo')
    const documentRequests: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentRequests.push(request.url())
    })

    const sprintName = page.getByLabel('Name')
    await expect(sprintName).toHaveValue('Sprint 1')
    await sprintName.fill('Sprint 1 (unsaved)')
    await sprintName.press('Enter')
    await expect(sprintName).toHaveValue('Sprint 1 (unsaved)')
    await expect(page).toHaveURL(`${sprintsPath}/${SPRINT.webshop1}`)
    expect(documentRequests).toEqual([])

    await page.goto(`${sprint1TasksPath}/new`) // a reload: the session cookie keeps us signed in
    documentRequests.length = 0
    const taskName = page.getByLabel('Name')
    await taskName.fill('Unsaved task')
    await taskName.press('Enter')
    await expect(taskName).toHaveValue('Unsaved task')
    await expect(page).toHaveURL(`${sprint1TasksPath}/new`)
    expect(documentRequests).toEqual([])
  })
})
