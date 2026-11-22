import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROJECT, SPRINT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'

const webshopSprints = `/projects/${PROJECT.webshop}/sprints`
const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'

async function renderList(path = webshopSprints) {
  const rendered = await renderRoute(path, { as: 'dev1' })
  const table = (await screen.findByRole('columnheader', { name: 'Start date' })).closest('table')
  if (!table) throw new Error('no table')
  return { ...rendered, table }
}

const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

describe('sprints list (SprintsList)', () => {
  it('AC-SPR-01: /projects/:projectId/sprints requires authentication; nothing is fetched while anonymous', async () => {
    const requests = recordRequests()
    await renderRoute(webshopSprints)
    expect(await screen.findByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
    expect(screen.queryByRole('columnheader', { name: 'Start date' })).toBeNull()
    expect(requests.filter((r) => r.pathname.startsWith('/databases/'))).toEqual([])
  })

  it('AC-SPR-01: any signed-in user may open it (spec §5.3: authentication only), even outside the project', async () => {
    await renderRoute(webshopSprints, { as: 'outsider' })
    expect(await screen.findByText('Sprint 2')).toBeVisible()
  })

  it('AC-SPR-01: class parity and columns Name, Start date, End date, Status, Tools', async () => {
    const { table } = await renderList()
    expect(table).toHaveClass(TABLE_CLASSES, { exact: true })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Start date', 'End date', 'Status', 'Tools'])
    expect(screen.getByRole('button', { name: 'New sprint' }).parentElement).toHaveClass('well')
  })

  it('AC-SPR-01 / D12: lists the project sprints with the literal status ACTIVE', async () => {
    const { table } = await renderList()
    const rows = bodyRows(table)
    expect(rows).toHaveLength(2)
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole('cell')
        .map((td) => td.textContent),
    ).toEqual(['Sprint 1', '2026-11-02', '2026-11-13', 'ACTIVE', 'Tasks'])
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[3]).toHaveTextContent('ACTIVE')
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Tasks' })).toHaveClass('btn btn-mini')
  })

  for (const [index, column] of ['Name', 'Start date', 'End date', 'Status'].entries()) {
    it(`AC-SPR-01: the ${column} cell opens the sprint's edit page`, async () => {
      const { table, user, router } = await renderList()
      const row = bodyRows(table)[1] as HTMLElement
      await user.click(within(row).getAllByRole('cell')[index] as HTMLElement)
      await waitFor(() => expect(router.state.location.pathname).toBe(`${webshopSprints}/${SPRINT.webshop2}`))
    })
  }

  it('AC-SPR-01: "Tasks" opens the sprint task list, not the edit page', async () => {
    const { table, user, router } = await renderList()
    const row = bodyRows(table)[1] as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Tasks' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${webshopSprints}/${SPRINT.webshop2}/tasks`))
    expect(await screen.findByText('Address form')).toBeVisible()
  })

  it('AC-SPR-01: "New sprint" opens /projects/:projectId/sprints/new', async () => {
    const { user, router } = await renderList()
    await user.click(screen.getByRole('button', { name: 'New sprint' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${webshopSprints}/new`))
  })

  it('AC-SPR-01: a project without sprints shows "No sprints defined" across all five columns', async () => {
    const requests = recordRequests()
    const { table } = await renderList(`/projects/${PROJECT.legacyCleanup}/sprints`)
    const cell = within(table).getByRole('cell', { name: 'No sprints defined' })
    expect(cell).toHaveAttribute('colspan', '5')
    expect(bodyRows(table)).toHaveLength(1)
    expect(requests.find((r) => r.pathname === '/databases/ascrum/collections/sprints')?.q).toEqual({
      projectId: PROJECT.legacyCleanup,
    })
  })
})
