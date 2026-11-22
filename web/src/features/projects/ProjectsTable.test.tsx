import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../api/types.ts'
import { renderRoute } from '../../test/renderRoute.tsx'
import { ProjectsTable } from './ProjectsTable.tsx'

const ME = 'me-id'
const PROJECTS: Project[] = [
  { id: 'p-po', name: 'Owned', desc: 'I am the PO', productOwner: ME, scrumMaster: 'x', teamMembers: [ME] },
  { id: 'p-smdev', name: 'Both', desc: 'SM and dev', productOwner: 'x', scrumMaster: ME, teamMembers: [ME] },
  { id: 'p-none', name: 'Other', desc: 'Not mine', productOwner: 'x', scrumMaster: 'y', teamMembers: ['z'] },
  // D13: no teamMembers field at all.
  { id: 'p-partial', name: 'Partial', desc: 'No team', productOwner: 'x' },
]

/** Renders the table on a test-only route, inside the real app and router (renderRoute). */
async function renderTable(currentUserId?: string) {
  // Signed in as po so the guarded routes the links lead to complete; the table only knows currentUserId.
  const rendered = await renderRoute('/table', {
    as: 'po',
    routes: [{ path: '/table', element: <ProjectsTable projects={PROJECTS} currentUserId={currentUserId} /> }],
  })
  await waitFor(() => expect(rendered.router.state.initialized).toBe(true))
  return rendered
}

function rolesCell(projectName: string): HTMLElement {
  const row = screen.getByText(projectName).closest('tr')
  if (!row) throw new Error(`no row for ${projectName}`)
  const cell = row.querySelectorAll('td')[2]
  if (!(cell instanceof HTMLElement)) throw new Error('no roles cell')
  return cell
}

describe('ProjectsTable', () => {
  it('class parity: the legacy table classes and column classes', async () => {
    await renderTable(ME)
    const table = screen.getByRole('table')
    expect(table).toHaveClass('table table-bordered table-condensed table-striped table-hover')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((th) => th.textContent)).toEqual(['Name', 'Description', 'My Role(s)', 'Tools'])
    expect(headers.map((th) => th.className)).toEqual(['span3', 'span5', 'span2', 'span2'])
  })

  it('AC-PRJ-02 / D20: roles render as "PO", "SM, DEV" or empty for the given user (D13: missing teamMembers is fine)', async () => {
    await renderTable(ME)
    expect(rolesCell('Owned')).toHaveTextContent(/^PO$/)
    expect(rolesCell('Both')).toHaveTextContent(/^SM, DEV$/)
    expect(rolesCell('Other')).toBeEmptyDOMElement()
    expect(rolesCell('Partial')).toBeEmptyDOMElement()
  })

  it('AC-PRJ-02: with no current user, every roles cell is empty', async () => {
    await renderTable()
    expect(screen.getAllByRole('row')).toHaveLength(1 + PROJECTS.length)
    for (const project of PROJECTS) expect(rolesCell(project.name)).toBeEmptyDOMElement()
  })

  it('AC-PRJ-02: the links work wherever the table is reused, with only projects + an optional user id', async () => {
    const { router, user } = await renderTable()
    await user.click(screen.getByText('Not mine'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/p-none/productbacklog'))
  })
})
