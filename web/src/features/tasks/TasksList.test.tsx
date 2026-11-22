import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROJECT, SPRINT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'

const sprint2Tasks = `/projects/${PROJECT.webshop}/sprints/${SPRINT.webshop2}/tasks`
const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'
/** stub/seed.ts numbers the seeded tasks 1..12 with the tasks collection's '5' prefix. */
const taskId = (n: number) => '5' + n.toString(16).padStart(23, '0')

async function renderList(path = sprint2Tasks) {
  const rendered = await renderRoute(path, { as: 'dev2' })
  const table = (await screen.findByRole('columnheader', { name: 'Remaining' })).closest('table')
  if (!table) throw new Error('no table')
  return { ...rendered, table }
}

const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

describe('tasks list (TasksList)', () => {
  it('AC-TSK-01: /projects/:projectId/sprints/:sprintId/tasks requires authentication; nothing is fetched while anonymous', async () => {
    const requests = recordRequests()
    await renderRoute(sprint2Tasks)
    expect(await screen.findByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
    expect(screen.queryByRole('columnheader', { name: 'Remaining' })).toBeNull()
    expect(requests.filter((r) => r.pathname.startsWith('/databases/'))).toEqual([])
  })

  it('AC-TSK-01: any signed-in user may open it (spec §5.3: authentication only), even outside the project', async () => {
    await renderRoute(sprint2Tasks, { as: 'outsider' })
    expect(await screen.findByText('Address form')).toBeVisible()
  })

  it('AC-TSK-01: class parity and columns Name, Estimation, Remaining, Tools', async () => {
    const { table } = await renderList()
    expect(table).toHaveClass(TABLE_CLASSES, { exact: true })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => [th.textContent, th.className]),
    ).toEqual([
      ['Name', 'span8'],
      ['Estimation', 'span1'],
      ['Remaining', 'span1'],
      ['Tools', 'span2'],
    ])
    expect(screen.getByRole('button', { name: 'New task' }).parentElement).toHaveClass('well')
  })

  it("AC-TSK-01: lists the sprint's tasks (queried by sprintId) with an empty Tools cell", async () => {
    const requests = recordRequests()
    const { table } = await renderList()
    const rows = bodyRows(table)
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((td) => td.textContent),
      ),
    ).toEqual([
      ['Address form', '3', '3', ''],
      ['Payment provider spike', '5', '4', ''],
      ['Shipping options', '3', '3', ''],
      ['Order history list', '3', '1', ''],
      ['Order details page', '2', '2', ''],
    ])
    expect(requests.find((r) => r.pathname === '/databases/ascrum/collections/tasks')?.q).toEqual({
      sprintId: SPRINT.webshop2,
    })
  })

  it('AC-TSK-01: the Name cell opens the edit page; the other cells do not', async () => {
    const { table, user, router } = await renderList()
    const row = bodyRows(table)[0] as HTMLElement
    const [, estimation, remaining, tools] = within(row).getAllByRole('cell')
    for (const cell of [estimation, remaining, tools]) await user.click(cell as HTMLElement)
    expect(router.state.location.pathname).toBe(sprint2Tasks)

    await user.click(within(row).getByText('Address form'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${sprint2Tasks}/${taskId(8)}`))
  })

  it('AC-TSK-01: "New task" opens …/tasks/new', async () => {
    const { user, router } = await renderList()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${sprint2Tasks}/new`))
  })

  it('AC-TSK-01: a sprint without tasks shows "No tasks defined for this sprint" across all four columns', async () => {
    const { table } = await renderList(`/projects/${PROJECT.mobileApp}/sprints/${SPRINT.mobile1}/tasks`)
    const cell = within(table).getByRole('cell', { name: 'No tasks defined for this sprint' })
    expect(cell).toHaveAttribute('colspan', '4')
    expect(bodyRows(table)).toHaveLength(1)
  })
})
