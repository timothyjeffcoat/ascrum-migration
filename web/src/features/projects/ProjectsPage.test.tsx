import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROJECT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute, type Persona } from '../../test/renderRoute.tsx'

async function renderProjects(as: Persona) {
  const rendered = await renderRoute('/projects', { as })
  const table = await screen.findByRole('table')
  return { ...rendered, table }
}

function rowOf(table: HTMLElement, projectName: string): HTMLElement {
  const row = within(table).getByText(projectName).closest('tr')
  if (!row) throw new Error(`no row for ${projectName}`)
  return row
}

function cellsOf(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')
}

describe('/projects (ProjectsPage)', () => {
  it('AC-PRJ-01: requires authentication; the projects load only after signing in, without a reload', async () => {
    const requests = recordRequests()
    const { user, router } = await renderRoute('/projects')
    const modal = await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.getByText('You must be logged in to access this part of the application.')).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
    expect(requests.some((r) => r.pathname.endsWith('/collections/projects'))).toBe(false)

    const dialog = modal.closest('.modal')
    if (!(dialog instanceof HTMLElement)) throw new Error('no modal')
    await user.type(within(dialog).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(dialog).getByLabelText('Password'), 'demo')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))

    const table = await screen.findByRole('table')
    expect(router.state.location.pathname).toBe('/projects')
    expect(within(table).getByText('Webshop')).toBeVisible()
    expect(requests.filter((r) => r.pathname.endsWith('/collections/projects'))).toHaveLength(1)
  })

  it('class parity: /projects renders the legacy projects table', async () => {
    const { table } = await renderProjects('po')
    expect(table).toHaveClass('table table-bordered table-condensed table-striped table-hover')
  })

  // Legacy projects.spec:22 "attaches the list of projects to the scope" (adapted: the loader's list is rendered).
  it('AC-PRJ-01 (legacy projects.spec:22): every project from the loader gets a row with Name, Description, My Role(s), Tools', async () => {
    const { table } = await renderProjects('po')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Description', 'My Role(s)', 'Tools'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => cellsOf(row)[0])).toEqual(['Webshop', 'Mobile App', 'Legacy Cleanup'])
    expect(cellsOf(rowOf(table, 'Webshop'))).toEqual([
      'Webshop',
      'Online store rewrite',
      'PO',
      'Product backlog Sprints',
    ])
  })

  // Legacy projects.spec:76 "calls getRoles on the project with the current user" (adapted: asserts the output).
  it('AC-PRJ-01 / D20 (legacy projects.spec:76): "My Role(s)" shows the signed-in user\'s roles, formatted', async () => {
    const { table } = await renderProjects('sm')
    expect(cellsOf(rowOf(table, 'Webshop'))[2]).toBe('SM')
    expect(cellsOf(rowOf(table, 'Mobile App'))[2]).toBe('PO')
    // D13: Legacy Cleanup has no teamMembers; legacy getRoles threw here.
    expect(cellsOf(rowOf(table, 'Legacy Cleanup'))[2]).toBe('')
  })

  it('AC-PRJ-01 / D20: a developer who is also scrum master elsewhere sees DEV and SM per project', async () => {
    const { table } = await renderProjects('dev1')
    expect(cellsOf(rowOf(table, 'Webshop'))[2]).toBe('DEV')
    expect(cellsOf(rowOf(table, 'Mobile App'))[2]).toBe('SM')
  })

  // Legacy projects.spec:48 "manageBacklog changes the location".
  it('AC-PRJ-01 (legacy projects.spec:48): the name cell, the description cell and "Product backlog" open the backlog', async () => {
    const backlogPath = `/projects/${PROJECT.webshop}/productbacklog`
    for (const target of ['Webshop', 'Online store rewrite', 'Product backlog']) {
      const { table, router, user, unmount } = await renderProjects('po')
      const row = rowOf(table, 'Webshop')
      await user.click(within(row).getByText(target))
      await waitFor(() => expect(router.state.location.pathname).toBe(backlogPath))
      unmount()
    }
  })

  // Legacy projects.spec:62 "manageSprints changes the location".
  it('AC-PRJ-01 (legacy projects.spec:62): "Sprints" opens the project\'s sprints', async () => {
    const { table, router, user } = await renderProjects('po')
    await user.click(within(rowOf(table, 'Mobile App')).getByText('Sprints'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${PROJECT.mobileApp}/sprints`))
  })
})
