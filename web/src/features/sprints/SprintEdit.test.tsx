import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BACKLOG, PROJECT, SPRINT } from '../../../stub/seed.ts'
import type { Sprint } from '../../api/types.ts'
import { recordRequests, renderRoute, type RenderRouteResult } from '../../test/renderRoute.tsx'
import { failNext } from '../../test/stubControl.ts'
import { newSprintDraft, sprintFormInitial } from './SprintEdit.tsx'

const listPath = `/projects/${PROJECT.webshop}/sprints`
const newPath = `${listPath}/new`
const sprint1Path = `${listPath}/${SPRINT.webshop1}`
const SPRINTS = '/databases/ascrum/collections/sprints'
const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'

type Rendered = RenderRouteResult & { well: HTMLElement }

async function renderEdit(path: string): Promise<Rendered> {
  const rendered = await renderRoute(path, { as: 'dev1' })
  const heading = await screen.findByRole('heading', { name: 'Sprint' })
  const well = heading.parentElement
  if (!well) throw new Error('no well')
  return { ...rendered, well }
}

const button = (name: string) => screen.getByRole('button', { name })
/** The CRUD buttons' Remove; the picker rows have Remove buttons too. */
function crudRemove(): HTMLElement {
  const crud = button('Save').parentElement
  if (!crud) throw new Error('no CRUD buttons')
  return within(crud).getByRole('button', { name: 'Remove' })
}

/** The table right after one of the picker's legacy captions. */
function pickerTable(caption: string): HTMLElement {
  const table = screen.getByText(caption, { selector: 'label' }).nextElementSibling
  if (!(table instanceof HTMLElement) || table.tagName !== 'TABLE') throw new Error(`no table after ${caption}`)
  return table
}
const inSprint = () => pickerTable("Currently in the sprint's backlog")
const productBacklog = () => pickerTable('Product backlog')

/** Each body row as [name, estimation]. */
function rowsOf(table: HTMLElement): string[][] {
  const body = table.querySelector('tbody')
  if (!body) throw new Error('no tbody')
  return [...body.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('td')].slice(0, 2).map((td) => td.textContent ?? ''),
  )
}
function totalOf(table: HTMLElement): string[] {
  return [...(table.querySelector('tfoot tr')?.querySelectorAll('td') ?? [])].map((td) => td.textContent ?? '')
}
function rowWith(table: HTMLElement, name: string): HTMLElement {
  const row = within(table).getByText(name).closest('tr')
  if (!row) throw new Error(`no row ${name}`)
  return row
}

const NEW_SPRINT = { Name: 'Sprint 3', Capacity: '18', 'Start date': 'next Monday', 'End date': 'in two weeks' }

async function fillNew({ user }: RenderRouteResult) {
  for (const [label, text] of Object.entries(NEW_SPRINT)) await user.type(screen.getByLabelText(label), text)
}

/** P4: `defaultPrevented` of every submit event that reaches window (after React's onSubmit ran). */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

describe('sprint edit (SprintEdit, SprintBacklogPicker)', () => {
  for (const [route, path] of [
    ['/projects/:projectId/sprints/new', newPath],
    ['/projects/:projectId/sprints/:itemId', sprint1Path],
  ] as const) {
    it(`AC-SPR-02 / §5.3 R8/R9: an anonymous deep link to ${route} asks for a login and fetches nothing`, async () => {
      const requests = recordRequests()
      await renderRoute(path)
      expect(await screen.findByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
      expect(screen.queryByRole('heading', { name: 'Sprint' })).toBeNull()
      expect(requests.filter((r) => r.pathname.startsWith('/databases/'))).toEqual([])
    })

    it(`AC-SPR-02 / §5.3 R8/R9: any signed-in user may open ${route} (authentication only), even outside the project`, async () => {
      await renderRoute(path, { as: 'outsider' })
      expect(await screen.findByRole('heading', { name: 'Sprint' })).toBeVisible()
    })
  }

  it('class parity: the well, the legacy field classes and names, and both picker tables', async () => {
    const { well } = await renderEdit(sprint1Path)
    expect(well).toHaveClass('well')
    expect(screen.getByRole('heading', { name: 'Sprint backlog' })).toBeVisible()
    expect(screen.getByLabelText('Name')).toHaveClass('span10')
    for (const label of ['Capacity', 'Start date', 'End date'])
      expect(screen.getByLabelText(label)).toHaveClass('span5')
    expect(screen.getByLabelText('Capacity')).toHaveAttribute('type', 'number')
    // Legacy markup quirks kept (inventory): three inputs named "name", capacity named "description".
    expect(screen.getByLabelText('Start date')).toHaveAttribute('name', 'name')
    expect(screen.getByLabelText('End date')).toHaveAttribute('name', 'name')
    expect(screen.getByLabelText('Capacity')).toHaveAttribute('name', 'description')
    expect(inSprint()).toHaveClass(TABLE_CLASSES, { exact: true })
    expect(productBacklog()).toHaveClass(TABLE_CLASSES, { exact: true })
    expect(button('Save')).toHaveClass('btn btn-primary save')
  })

  it('AC-SPR-03: every button in the form is type="button"', async () => {
    const { well } = await renderEdit(sprint1Path)
    const buttons = within(well).getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(5)
    expect(new Set(buttons.map((b) => b.getAttribute('type')))).toEqual(new Set(['button']))
  })

  it('AC-SPR-02: the §5.6 draft is {projectId, name, start, end: "", sprintBacklog: []}', () => {
    expect(newSprintDraft('p1')).toEqual({ projectId: 'p1', name: '', start: '', end: '', sprintBacklog: [] })
  })

  it('AC-SPR-04 / §5.6: a loaded sprint without sprintBacklog gets [] in the form only', () => {
    const loaded: Sprint = { id: 's', projectId: 'p', name: 'S', capacity: 1, start: 'a', end: 'b' }
    expect(sprintFormInitial(loaded).sprintBacklog).toEqual([])
    expect(loaded).not.toHaveProperty('sprintBacklog')
  })

  it('AC-SPR-02: a new sprint starts empty: Save disabled, no Remove, the whole backlog on the right', async () => {
    await renderEdit(newPath)
    for (const label of ['Name', 'Start date', 'End date']) expect(screen.getByLabelText(label)).toHaveValue('')
    expect(screen.getByLabelText('Capacity')).toHaveValue(null)
    expect(button('Save')).toBeDisabled()
    expect(button('Revert changes')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull() // no CRUD Remove, and no sprint items
    expect(rowsOf(inSprint())).toEqual([])
    expect(totalOf(inSprint())).toEqual(['Estimation in total', '0', '-'])
    expect(rowsOf(productBacklog()).map(([name]) => name)).toEqual([
      'Product catalogue',
      'Shopping cart',
      'Checkout',
      'Order history',
      'Search',
      'Wish list',
    ])
  })

  it('AC-SPR-02: Name, Capacity, Start date and End date are all required', async () => {
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    expect(button('Save')).toBeEnabled()
    for (const [label, text] of Object.entries(NEW_SPRINT)) {
      const field = screen.getByLabelText(label)
      await rendered.user.clear(field)
      expect(button('Save'), `${label} cleared`).toBeDisabled()
      await rendered.user.type(field, text)
      expect(button('Save'), `${label} restored`).toBeEnabled()
    }
  })

  it('AC-SPR-02 / D12: dates are free text and capacity is a number (numberFields); saving a new sprint returns to the list', async () => {
    const requests = recordRequests()
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(
      within(rowWith(productBacklog(), 'Search')).getByRole('button', { name: 'Add to sprint' }),
    )
    await rendered.user.click(button('Save'))

    await waitFor(() => expect(rendered.router.state.location.pathname).toBe(listPath))
    expect(await screen.findByText('Sprint 3')).toBeVisible()
    expect(requests.find((r) => r.method === 'POST' && r.pathname === SPRINTS)?.body).toEqual({
      projectId: PROJECT.webshop,
      name: 'Sprint 3',
      capacity: 18,
      start: 'next Monday',
      end: 'in two weeks',
      sprintBacklog: [BACKLOG.search],
    })
  })

  it('AC-SPR-02: the edit route loads the sprint; Save is disabled until a change; Remove is offered', async () => {
    await renderEdit(sprint1Path)
    expect(screen.getByLabelText('Name')).toHaveValue('Sprint 1')
    expect(screen.getByLabelText('Capacity')).toHaveValue(20)
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-02')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-13')
    expect(button('Save')).toBeDisabled()
    expect(crudRemove()).toHaveClass('btn btn-danger remove')
  })

  it('AC-SPR-03: the left table lists the sprint items with their estimation; the right one the rest of the backlog', async () => {
    await renderEdit(`${listPath}/${SPRINT.webshop2}`)
    expect(rowsOf(inSprint())).toEqual([
      ['Checkout', '13'],
      ['Order history', '5'],
    ])
    expect(totalOf(inSprint())).toEqual(['Estimation in total', '18', '-'])
    expect(rowsOf(productBacklog())).toEqual([
      ['Product catalogue', '5'],
      ['Shopping cart', '8'],
      ['Search', '8'],
      ['Wish list', '3'],
    ])
    expect(within(rowWith(inSprint(), 'Checkout')).getByRole('button', { name: 'Remove' })).toHaveClass(
      'btn btn-mini btn-danger',
    )
    expect(within(rowWith(productBacklog(), 'Search')).getByRole('button', { name: 'Add to sprint' })).toHaveClass(
      'btn btn-mini',
    )
  })

  it('AC-SPR-04 / D13: an unknown backlog id is a blank row counted as 0 in the total', async () => {
    await renderEdit(sprint1Path)
    expect(rowsOf(inSprint())).toEqual([
      ['Product catalogue', '5'],
      ['Shopping cart', '8'],
      ['', ''],
    ])
    expect(totalOf(inSprint())).toEqual(['Estimation in total', '13', '-'])
  })

  it('AC-SPR-04 / D13: the blank row is removable, and saving drops the unknown id', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(sprint1Path)
    const blank = inSprint().querySelectorAll('tbody tr')[2] as HTMLElement
    await user.click(within(blank).getByRole('button', { name: 'Remove' }))

    expect(rowsOf(inSprint())).toHaveLength(2)
    expect(totalOf(inSprint())[1]).toBe('13')
    expect(button('Save')).toBeEnabled()
    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      sprintBacklog: [BACKLOG.catalogue, BACKLOG.cart],
    })
  })

  it('AC-SPR-03: "Add to sprint" moves the item to the left at once, updates the total and makes the form dirty', async () => {
    const { user } = await renderEdit(sprint1Path)
    expect(button('Save')).toBeDisabled()
    await user.click(within(rowWith(productBacklog(), 'Checkout')).getByRole('button', { name: 'Add to sprint' }))

    expect(rowsOf(inSprint()).map(([name]) => name)).toEqual(['Product catalogue', 'Shopping cart', '', 'Checkout'])
    expect(totalOf(inSprint())[1]).toBe('26')
    expect(within(productBacklog()).queryByText('Checkout')).toBeNull()
    expect(button('Save')).toBeEnabled()
    expect(button('Revert changes')).toBeEnabled()
  })

  it('AC-SPR-03: "Remove" moves the item back to the right at once and makes the form dirty; revert restores both', async () => {
    const { user } = await renderEdit(sprint1Path)
    await user.click(within(rowWith(inSprint(), 'Shopping cart')).getByRole('button', { name: 'Remove' }))

    expect(rowsOf(inSprint()).map(([name]) => name)).toEqual(['Product catalogue', ''])
    expect(totalOf(inSprint())[1]).toBe('5')
    expect(within(productBacklog()).getByText('Shopping cart')).toBeVisible()
    expect(button('Save')).toBeEnabled()

    await user.click(button('Revert changes'))
    expect(rowsOf(inSprint()).map(([name]) => name)).toEqual(['Product catalogue', 'Shopping cart', ''])
    expect(within(productBacklog()).queryByText('Shopping cart')).toBeNull()
    expect(button('Save')).toBeDisabled()
  })

  it('AC-SPR-03: item names in both tables link to /projects/:projectId/productbacklog/:itemId', async () => {
    const left = await renderEdit(sprint1Path)
    await left.user.click(within(inSprint()).getByText('Shopping cart'))
    await waitFor(() =>
      expect(left.router.state.location.pathname).toBe(`/projects/${PROJECT.webshop}/productbacklog/${BACKLOG.cart}`),
    )
    expect(await screen.findByRole('heading', { name: 'Product backlog item' })).toBeVisible()
    left.unmount()

    const right = await renderEdit(sprint1Path)
    await right.user.click(within(productBacklog()).getByText('Wish list'))
    await waitFor(() =>
      expect(right.router.state.location.pathname).toBe(
        `/projects/${PROJECT.webshop}/productbacklog/${BACKLOG.wishList}`,
      ),
    )
  })

  it('AC-SPR-05: saving an existing sprint PUTs it and returns to the sprints list', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(`${listPath}/${SPRINT.webshop2}`)
    await user.clear(screen.getByLabelText('End date'))
    await user.type(screen.getByLabelText('End date'), 'Friday')
    await user.click(button('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    expect(await screen.findByText('Friday')).toBeVisible()
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`${SPRINTS}/${SPRINT.webshop2}`)
    expect(put?.body).toEqual({
      projectId: PROJECT.webshop,
      name: 'Sprint 2',
      capacity: 20,
      start: '2026-11-16',
      end: 'Friday',
      sprintBacklog: [BACKLOG.checkout, BACKLOG.orderHistory],
    })
  })

  it('AC-SPR-05: removing a sprint DELETEs it and returns to the sprints list', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(`${listPath}/${SPRINT.webshop2}`)
    await user.click(crudRemove())

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Sprint 1')
    expect(screen.queryByText('Sprint 2')).toBeNull()
    expect(requests.some((r) => r.method === 'DELETE' && r.pathname === `${SPRINTS}/${SPRINT.webshop2}`)).toBe(true)
  })

  it('AC-SPR-05 / D14: a failed save notifies-current crud.sprint.save.error and keeps the edits', async () => {
    failNext('POST', SPRINTS, 500)
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a sprint...')).toHaveClass('alert alert-error')
    expect(rendered.router.state.location.pathname).toBe(newPath)
    expect(screen.getByLabelText('Name')).toHaveValue('Sprint 3')
  })

  it('AC-SPR-05 / D14: a failed save of an existing sprint notifies-current crud.sprint.save.error', async () => {
    failNext('PUT', `${SPRINTS}/*`, 500)
    const { user, router } = await renderEdit(sprint1Path)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a sprint...')).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(sprint1Path)
  })

  it('AC-SPR-05 / D14: a failed remove notifies-current crud.sprint.remove.error and stays', async () => {
    failNext('DELETE', `${SPRINTS}/*`, 500)
    const { user, router } = await renderEdit(sprint1Path)
    await user.click(crudRemove())

    expect(await screen.findByText('Something went wrong when removing a sprint...')).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(sprint1Path)
  })

  it('AC-SPR-05 / D14: the error is notify-current: it is gone after the next navigation', async () => {
    failNext('PUT', `${SPRINTS}/*`, 500)
    const { user, router } = await renderEdit(sprint1Path)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))
    await screen.findByText('Something went wrong when saving a sprint...')

    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Sprint 1!')
    expect(screen.queryByText('Something went wrong when saving a sprint...')).toBeNull()
  })

  it('AC-SPR-02 / AC-API-04: an unknown sprint id shows "Route change error" and no form', async () => {
    await renderRoute(`${listPath}/${BACKLOG.deleted}`, { as: 'dev1' })
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
    expect(screen.queryByRole('heading', { name: 'Sprint' })).toBeNull()
  })

  it('P4: Enter in the Name field neither saves nor navigates, and the edits stay', async () => {
    const { user, router } = await renderEdit(sprint1Path)
    await waitFor(() => expect(router.state.initialized).toBe(true))
    const name = screen.getByLabelText('Name')
    await user.type(name, ' renamed')
    const requests = recordRequests()
    await user.type(name, '{Enter}')

    expect(name).toHaveValue('Sprint 1 renamed')
    expect(requests).toEqual([])
    expect(router.state.location.pathname).toBe(sprint1Path)
  })

  it('P4: a submit of the sprint form is cancelled (the browser would not reload the page)', async () => {
    const { well } = await renderEdit(sprint1Path)
    const form = well.querySelector('form')
    if (!form) throw new Error('no form')
    const submits = watchSubmits()
    form.requestSubmit()
    expect(submits).toEqual([true])
  })
})

describe('sprint edit: trimming (P6)', () => {
  it('P6 / DSC-B-1: a new sprint with a spaces-only Name keeps Save disabled; padded text is saved trimmed', async () => {
    const requests = recordRequests()
    const rendered = await renderEdit(newPath)
    const { user } = rendered
    await user.type(screen.getByLabelText('Name'), '   ')
    await user.type(screen.getByLabelText('Capacity'), '5')
    await user.type(screen.getByLabelText('Start date'), '  2026-01-05  ')
    await user.type(screen.getByLabelText('End date'), ' 2026-01-16')
    expect(screen.getByLabelText('Name')).toHaveValue('   ')
    expect(button('Save')).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Sprint 3 ')
    await user.click(button('Save'))
    await waitFor(() => expect(rendered.router.state.location.pathname).toBe(listPath))
    expect(requests.find((r) => r.method === 'POST' && r.pathname === SPRINTS)?.body).toEqual({
      projectId: PROJECT.webshop,
      name: 'Sprint 3',
      capacity: 5,
      start: '2026-01-05',
      end: '2026-01-16',
      sprintBacklog: [],
    })
  })
})
