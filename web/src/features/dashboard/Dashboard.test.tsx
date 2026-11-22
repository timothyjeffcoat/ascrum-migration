import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROJECT } from '../../../stub/seed.ts'
import { failNext, resetStub } from '../../test/stubControl.ts'
import { stubContext } from '../../test/server.ts'
import { recordRequests, renderRoute, waitForShell, type Persona } from '../../test/renderRoute.tsx'

const PROJECTS_PATH = '/databases/ascrum/collections/projects'
const TASKS_PATH = '/databases/ascrum/collections/tasks'
const SEEDED_TASKS = 12 // stub/seed.ts: all on Webshop, all five states, some unassigned

/** The two tables under the "My projects" and "My tasks" headings. */
async function renderDashboard(as: Persona) {
  const rendered = await renderRoute('/dashboard', { as })
  await screen.findByRole('heading', { name: 'My tasks' })
  const [projectsTable, tasksTable] = screen.getAllByRole('table')
  if (!projectsTable || !tasksTable) throw new Error('expected two tables')
  return { ...rendered, projectsTable, tasksTable }
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  const row = within(table).getByRole('cell', { name }).closest('tr')
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

function cellsOf(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')
}

function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1)
}

describe('/dashboard (Dashboard)', () => {
  it('AC-DSH-01 / D4: anonymous users get the login modal and nothing is fetched; signing in completes the load without a reload', async () => {
    const requests = recordRequests()
    const { user, router } = await renderRoute('/dashboard')
    const dialog = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal')
    if (!(dialog instanceof HTMLElement)) throw new Error('no modal')
    expect(within(dialog).getByText('You must be logged in to access this part of the application.')).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'My projects' })).toBeNull()
    expect(requests.filter((r) => r.pathname === PROJECTS_PATH || r.pathname === TASKS_PATH)).toEqual([])

    await user.type(within(dialog).getByLabelText('E-mail'), 'dev1@ascrum.test')
    await user.type(within(dialog).getByLabelText('Password'), 'demo')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))

    await screen.findByRole('heading', { name: 'My tasks' })
    expect(router.state.location.pathname).toBe('/dashboard')
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(requests.filter((r) => r.pathname === PROJECTS_PATH)).toHaveLength(1)
    expect(requests.filter((r) => r.pathname === TASKS_PATH)).toHaveLength(1)
  })

  it('AC-DSH-01 / D4: cancelling the login goes to / and on to /projectsinfo; the dashboard data is never fetched', async () => {
    const requests = recordRequests()
    const { user, router } = await renderRoute('/dashboard')
    const dialog = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal')
    if (!(dialog instanceof HTMLElement)) throw new Error('no modal')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo'))
    expect(await screen.findByRole('heading', { name: 'Projects info' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'My tasks' })).toBeNull()
    expect(requests.some((r) => r.pathname === TASKS_PATH)).toBe(false)
  })

  it('class parity: both dashboard tables carry the legacy table classes and column spans', async () => {
    const { projectsTable, tasksTable } = await renderDashboard('dev1')
    const legacy = 'table table-bordered table-condensed table-striped table-hover'
    expect(projectsTable).toHaveClass(legacy)
    expect(tasksTable).toHaveClass(legacy)
    expect(
      within(tasksTable)
        .getAllByRole('columnheader')
        .map((th) => th.className),
    ).toEqual(['span8', 'span1', 'span1', 'span2'])
    // The headings are legacy's <h4>s, and the projects table sits in the ng-include wrapper <div>.
    const myProjects = screen.getByRole('heading', { name: 'My projects', level: 4 })
    expect(myProjects).toBeVisible()
    expect(screen.getByRole('heading', { name: 'My tasks', level: 4 })).toBeVisible()
    // DEV-dashboard-01: checking only for a DIV parent could not fail (without the wrapper the parent is
    // the shell's div.container-fluid). The wrapper is a class-less <div> right after the "My projects" <h4>.
    const wrapper = projectsTable.parentElement
    expect(wrapper?.tagName).toBe('DIV')
    expect(wrapper).not.toHaveAttribute('class')
    expect(wrapper?.previousElementSibling).toBe(myProjects)
  })

  it('AC-DSH-01 / D2: "My projects" lists ALL projects and "My tasks" ALL tasks in storage order, both fetched with q={}', async () => {
    const requests = recordRequests()
    const { projectsTable, tasksTable } = await renderDashboard('dev2')

    expect(bodyRows(projectsTable).map((row) => cellsOf(row)[0])).toEqual(['Webshop', 'Mobile App', 'Legacy Cleanup'])
    expect(
      within(tasksTable)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Estimation', 'Remaining', 'Tools'])
    const rows = bodyRows(tasksTable)
    expect(rows).toHaveLength(SEEDED_TASKS)
    // DEV-dashboard-02: legacy rendered Tasks.all() in store order, unsorted; so does the port (stub/seed.ts order).
    expect(rows.map((row) => cellsOf(row)[0])).toEqual([
      'Design catalogue page',
      'Category API endpoint',
      'Product image thumbnails',
      'Cart data model',
      'Cart UI',
      'Cart persistence',
      'Price rounding bug',
      'Address form',
      'Payment provider spike',
      'Shipping options',
      'Order history list',
      'Order details page',
    ])
    // Tasks assigned to dev1 and unassigned ones are listed too (D2: not filtered by user).
    expect(cellsOf(rowOf(tasksTable, 'Design catalogue page'))).toEqual(['Design catalogue page', '3', '0', ''])
    expect(cellsOf(rowOf(tasksTable, 'Cart UI'))).toEqual(['Cart UI', '5', '5', ''])
    expect(within(tasksTable).queryByText('No tasks for you!')).toBeNull()

    expect(requests.find((r) => r.pathname === PROJECTS_PATH)?.q).toEqual({})
    expect(requests.find((r) => r.pathname === TASKS_PATH)?.q).toEqual({})
  })

  it('AC-DSH-01 / D3: "My Role(s)" shows the signed-in user\'s roles (legacy left it empty)', async () => {
    const { projectsTable } = await renderDashboard('sm')
    expect(cellsOf(rowOf(projectsTable, 'Webshop'))).toEqual([
      'Webshop',
      'Online store rewrite',
      'SM',
      'Product backlog Sprints',
    ])
    expect(cellsOf(rowOf(projectsTable, 'Mobile App'))[2]).toBe('PO')
    // D13: Legacy Cleanup has no teamMembers field.
    expect(cellsOf(rowOf(projectsTable, 'Legacy Cleanup'))[2]).toBe('')
  })

  it('AC-DSH-01 / D3: the project links open /projects/<id>/… (legacy built /projects/[object Object]/…)', async () => {
    const backlog = `/projects/${PROJECT.webshop}/productbacklog`
    for (const target of ['Webshop', 'Online store rewrite', 'Product backlog']) {
      const { projectsTable, router, user, unmount } = await renderDashboard('po')
      await user.click(within(rowOf(projectsTable, 'Webshop')).getByText(target))
      await waitFor(() => expect(router.state.location.pathname).toBe(backlog))
      unmount()
    }
    const { projectsTable, router, user } = await renderDashboard('po')
    await user.click(within(rowOf(projectsTable, 'Mobile App')).getByText('Sprints'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${PROJECT.mobileApp}/sprints`))
  })

  it('AC-DSH-01 / D2: a signed-in user with no role anywhere still sees every project (roles empty) and every task', async () => {
    const { projectsTable, tasksTable } = await renderDashboard('outsider')
    const rows = bodyRows(projectsTable)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => cellsOf(row)[2])).toEqual(['', '', ''])
    expect(bodyRows(tasksTable)).toHaveLength(SEEDED_TASKS)
  })

  it('AC-DSH-01: with no tasks at all, "My tasks" shows "No tasks for you!" across the four columns', async () => {
    // Seeding, not mocking: the stub's own store starts this test with no tasks (resetStub runs again next test).
    resetStub()
    stubContext.store.collections.tasks = []
    const { tasksTable, projectsTable } = await renderDashboard('dev1')
    const rows = bodyRows(tasksTable)
    expect(rows).toHaveLength(1)
    const cell = within(tasksTable).getByRole('cell', { name: 'No tasks for you!' })
    expect(cell).toHaveAttribute('colspan', '4')
    expect(bodyRows(projectsTable)).toHaveLength(3)
  })

  it('AC-DSH-01 / AC-SHELL-01: the brand link takes a signed-in user from /projectsinfo to the dashboard', async () => {
    const { router, user } = await renderRoute('/projectsinfo', { as: 'dev1' })
    await waitForShell(router)
    await user.click(screen.getByText('AScrum'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(await screen.findByRole('heading', { name: 'My projects' })).toBeVisible()
    expect(bodyRows(screen.getAllByRole('table')[1] ?? document.body)).toHaveLength(SEEDED_TASKS)
  })

  it('AC-DSH-01: a failed tasks load shows "Route change error" in the shell, with no dashboard content', async () => {
    failNext('GET', TASKS_PATH, 500)
    const { router } = await renderRoute('/dashboard', { as: 'dev1' })
    expect(await screen.findByText('Route change error')).toBeVisible()
    expect(router.state.location.pathname).toBe('/dashboard')
    expect(screen.queryByRole('heading', { name: 'My projects' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
