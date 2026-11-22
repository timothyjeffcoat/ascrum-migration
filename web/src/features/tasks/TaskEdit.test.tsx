import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BACKLOG, PROJECT, SPRINT, USER } from '../../../stub/seed.ts'
import { findById } from '../../../stub/store.ts'
import { TASK_STATES } from '../../domain/tasks.ts'
import { recordRequests, renderRoute, type RenderRouteResult } from '../../test/renderRoute.tsx'
import { stubContext } from '../../test/server.ts'
import { failNext } from '../../test/stubControl.ts'
import { newTaskDraft } from './TaskEdit.tsx'

const listPath = `/projects/${PROJECT.webshop}/sprints/${SPRINT.webshop1}/tasks`
const newPath = `${listPath}/new`
/** stub/seed.ts numbers the seeded tasks 1..12 with the tasks collection's '5' prefix. */
const taskId = (n: number) => '5' + n.toString(16).padStart(23, '0')
const designPath = `${listPath}/${taskId(1)}` // "Design catalogue page", DONE, assigned to dev1
const cartUiPath = `${listPath}/${taskId(5)}` // "Cart UI", TODO, unassigned
const TASKS = '/databases/ascrum/collections/tasks'
const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const DEV1 = 'Developer Dana (dev1@ascrum.test)'
const DEV2 = 'Coder Devon (dev2@ascrum.test)'

type Rendered = RenderRouteResult & { form: HTMLFormElement }

async function renderEdit(path: string): Promise<Rendered> {
  const rendered = await renderRoute(path, { as: 'dev1' })
  const form = (await screen.findByLabelText('Product Backlog item')).closest('form')
  if (!form) throw new Error('no form')
  return { ...rendered, form }
}

const button = (name: string) => screen.getByRole('button', { name })
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement
const optionLabels = (label: string) => [...select(label).options].map((option) => option.textContent)
const selectedLabel = (label: string) => select(label).selectedOptions[0]?.textContent

const NEW_TASK = {
  Name: 'Checkout button',
  Description: 'Add a checkout button to the cart',
  Estimation: '2',
  Remaining: '2',
}

async function fillNew({ user }: RenderRouteResult) {
  for (const [label, text] of Object.entries(NEW_TASK)) await user.type(screen.getByLabelText(label), text)
  await user.selectOptions(select('Product Backlog item'), 'Shopping cart')
}

/** Change a seeded document in the stub after resetStub() (P5 scenarios that the seed reaches in two clicks). */
function patchStub(collection: 'projects' | 'sprints' | 'tasks', id: string, fields: Record<string, unknown>) {
  const doc = findById(stubContext.store, collection, id)
  if (!doc) throw new Error(`no ${collection} ${id}`)
  Object.assign(doc, fields)
}

/** P4: `defaultPrevented` of every submit event that reaches window (after React's onSubmit ran). */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

describe('task edit (TaskEdit)', () => {
  for (const [route, path] of [
    ['/projects/:projectId/sprints/:sprintId/tasks/new', newPath],
    ['/projects/:projectId/sprints/:sprintId/tasks/:itemId', designPath],
  ] as const) {
    it(`AC-TSK-02 / §5.3 R11/R12: an anonymous deep link to ${route} asks for a login and fetches nothing`, async () => {
      const requests = recordRequests()
      await renderRoute(path)
      expect(await screen.findByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
      expect(screen.queryByLabelText('Product Backlog item')).toBeNull()
      expect(requests.filter((r) => r.pathname.startsWith('/databases/'))).toEqual([])
    })

    it(`AC-TSK-02 / §5.3 R11/R12: any signed-in user may open ${route} (authentication only), even outside the project`, async () => {
      await renderRoute(path, { as: 'outsider' })
      expect(await screen.findByLabelText('Product Backlog item')).toBeVisible()
    })
  }

  it('class parity: form > .well with the legacy field classes, names and type="button" buttons', async () => {
    const { form } = await renderEdit(designPath)
    const well = form.firstElementChild
    expect(well).toHaveClass('well', { exact: true })
    for (const label of ['Name', 'Product Backlog item', 'Description', 'Assigned to'])
      expect(screen.getByLabelText(label)).toHaveClass('span10')
    for (const label of ['Estimation', 'Remaining', 'State']) expect(screen.getByLabelText(label)).toHaveClass('span5')
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA')
    // Legacy markup quirks kept (inventory): the backlog select is "productBacklog"; two selects are "state".
    expect(select('Product Backlog item')).toHaveAttribute('name', 'productBacklog')
    expect(select('State')).toHaveAttribute('name', 'state')
    expect(select('Assigned to')).toHaveAttribute('name', 'state')
    expect(button('Save')).toHaveClass('btn btn-primary save')
    expect(
      within(form)
        .getAllByRole('button')
        .map((b) => b.getAttribute('type')),
    ).toEqual(['button', 'button', 'button'])
  })

  it('AC-TSK-02: the §5.6 draft is {projectId, sprintId, name:"", desc:"", state:"TODO"}', () => {
    expect(newTaskDraft('p1', 's1')).toEqual({ projectId: 'p1', sprintId: 's1', name: '', desc: '', state: 'TODO' })
  })

  it('AC-TSK-02: a new task starts from the draft: state TODO, blank selects, Save disabled, no Remove', async () => {
    await renderEdit(newPath)
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Description')).toHaveValue('')
    expect(screen.getByLabelText('Estimation')).toHaveValue(null)
    expect(screen.getByLabelText('Remaining')).toHaveValue(null)
    expect(selectedLabel('State')).toBe('TODO')
    expect(selectedLabel('Product Backlog item')).toBe('-- choose --')
    expect(selectedLabel('Assigned to')).toBe('-- unassigned --')
    expect(button('Save')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('AC-TSK-02: Product Backlog item offers getByIds(sprint.sprintBacklog) after a -- choose -- blank', async () => {
    const requests = recordRequests()
    await renderEdit(newPath)
    // Sprint 1 references a deleted item too (D13); getByIds simply does not return it.
    expect(optionLabels('Product Backlog item')).toEqual(['-- choose --', 'Product catalogue', 'Shopping cart'])
    expect(requests.find((r) => r.pathname === '/databases/ascrum/collections/productbacklog')?.q).toEqual({
      _id: { $in: [BACKLOG.catalogue, BACKLOG.cart, BACKLOG.deleted].map(($oid) => ({ $oid })) },
    })
  })

  it('AC-TSK-02: State offers TASK_STATES in order', async () => {
    await renderEdit(newPath)
    expect(optionLabels('State')).toEqual([...TASK_STATES])
  })

  it('AC-TSK-02: Assigned to offers getByIds(project.teamMembers) labelled fullName, after -- unassigned --', async () => {
    const requests = recordRequests()
    await renderEdit(newPath)
    expect(optionLabels('Assigned to')).toEqual(['-- unassigned --', DEV1, DEV2])
    expect(requests.find((r) => r.pathname === '/databases/ascrum/collections/users')?.q).toEqual({
      _id: { $in: [USER.dev1, USER.dev2].map(($oid) => ({ $oid })) },
    })
  })

  it('AC-TSK-02 / D13: a project without teamMembers offers only -- unassigned -- (no crash)', async () => {
    await renderEdit(`/projects/${PROJECT.legacyCleanup}/sprints/${SPRINT.webshop1}/tasks/new`)
    expect(optionLabels('Assigned to')).toEqual(['-- unassigned --'])
  })

  it('AC-TSK-02: Name, Product Backlog item, Description, Estimation and Remaining are required', async () => {
    const rendered = await renderEdit(newPath)
    const { user } = rendered
    await fillNew(rendered)
    expect(button('Save')).toBeEnabled()

    for (const [label, text] of Object.entries(NEW_TASK)) {
      const field = screen.getByLabelText(label)
      await user.clear(field)
      expect(button('Save'), `${label} cleared`).toBeDisabled()
      await user.type(field, text)
      expect(button('Save'), `${label} restored`).toBeEnabled()
    }
    await user.selectOptions(select('Product Backlog item'), '-- choose --')
    expect(button('Save'), 'backlog item cleared').toBeDisabled()
  })

  it('AC-TSK-02 / AC-TSK-03 / D6: saving a new task POSTs it and returns to the sprint task list', async () => {
    const requests = recordRequests()
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(button('Save'))

    await waitFor(() => expect(rendered.router.state.location.pathname).toBe(listPath))
    expect(await screen.findByText('Checkout button')).toBeVisible()
    expect(requests.find((r) => r.method === 'POST' && r.pathname === TASKS)?.body).toEqual({
      projectId: PROJECT.webshop,
      sprintId: SPRINT.webshop1,
      name: 'Checkout button',
      desc: 'Add a checkout button to the cart',
      estimation: 2,
      remaining: 2,
      state: 'TODO',
      productBacklogItemId: BACKLOG.cart,
    })
  })

  it('AC-TSK-02: the edit route loads the task; Save is disabled until a change; Remove is offered', async () => {
    await renderEdit(designPath)
    expect(screen.getByLabelText('Name')).toHaveValue('Design catalogue page')
    expect(selectedLabel('Product Backlog item')).toBe('Product catalogue')
    expect(screen.getByLabelText('Description')).toHaveValue('Design catalogue page')
    expect(screen.getByLabelText('Estimation')).toHaveValue(3)
    expect(screen.getByLabelText('Remaining')).toHaveValue(0)
    expect(selectedLabel('State')).toBe('DONE')
    expect(selectedLabel('Assigned to')).toBe(DEV1)
    expect(button('Save')).toBeDisabled()
    expect(button('Remove')).toHaveClass('btn btn-danger remove')
  })

  it('AC-TSK-03 / D6: saving an existing task PUTs it and returns to /projects/:projectId/sprints/:sprintId/tasks', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(cartUiPath)
    await user.clear(screen.getByLabelText('Remaining'))
    await user.type(screen.getByLabelText('Remaining'), '1')
    await user.selectOptions(select('State'), 'IN_TEST')
    await user.selectOptions(select('Assigned to'), DEV2)
    await user.click(button('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    expect(router.state.location.pathname).not.toBe('/admin/users') // legacy D6
    const row = (await screen.findByText('Cart UI')).closest('tr')
    if (!row) throw new Error('no row')
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('1')
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`${TASKS}/${taskId(5)}`)
    expect(put?.body).toEqual({
      projectId: PROJECT.webshop,
      sprintId: SPRINT.webshop1,
      productBacklogItemId: BACKLOG.cart,
      name: 'Cart UI',
      desc: 'Cart UI',
      estimation: 5,
      remaining: 1,
      state: 'IN_TEST',
      assignedUserId: USER.dev2,
    })
  })

  it('AC-TSK-02 / S13: choosing -- unassigned -- removes assignedUserId from the saved task', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(designPath)
    await user.selectOptions(select('Assigned to'), '-- unassigned --')
    expect(button('Save')).toBeEnabled()
    await user.click(button('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.body).toMatchObject({ name: 'Design catalogue page', state: 'DONE' })
    expect(put?.body).not.toHaveProperty('assignedUserId')
  })

  it('AC-TSK-02 / P5: a task whose backlog item left the sprint must be re-chosen before Save', async () => {
    // "Product catalogue" removed from Sprint 1: tasks 1–3 now point at an item the select does not offer.
    patchStub('sprints', SPRINT.webshop1, { sprintBacklog: [BACKLOG.cart] })
    const requests = recordRequests()
    const { user, router } = await renderEdit(designPath)
    expect(selectedLabel('Product Backlog item')).toBe('-- choose --')
    expect(select('Product Backlog item')).toBeInvalid() // the form's required error (no message in legacy markup)

    await user.type(screen.getByLabelText('Name'), '!')
    expect(button('Save')).toBeDisabled()
    await user.click(button('Save'))
    expect(requests.filter((r) => r.method === 'PUT')).toEqual([])

    await user.selectOptions(select('Product Backlog item'), 'Shopping cart')
    expect(select('Product Backlog item')).toBeValid()
    expect(button('Save')).toBeEnabled()
    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      name: 'Design catalogue page!',
      productBacklogItemId: BACKLOG.cart,
    })
  })

  it('AC-TSK-02 / P5: a task whose assignee left the team shows unassigned and saving unassigns', async () => {
    // dev1 removed from Webshop's team: task 1 is still assigned to dev1 in the store.
    patchStub('projects', PROJECT.webshop, { teamMembers: [USER.dev2] })
    const requests = recordRequests()
    const { user, router } = await renderEdit(designPath)
    expect(selectedLabel('Assigned to')).toBe('-- unassigned --')

    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.body).toMatchObject({ name: 'Design catalogue page!', productBacklogItemId: BACKLOG.catalogue })
    // S13 payload convention: unassigned = no assignedUserId field.
    expect(put?.body).not.toHaveProperty('assignedUserId')
  })

  it('AC-TSK-02 / P5: a task with a malformed state must have a state chosen before Save', async () => {
    patchStub('tasks', taskId(1), { state: 'WAITING' })
    const requests = recordRequests()
    const { user, router } = await renderEdit(designPath)

    await user.type(screen.getByLabelText('Name'), '!')
    expect(button('Save')).toBeDisabled()
    await user.click(button('Save'))
    expect(requests.filter((r) => r.method === 'PUT')).toEqual([])

    await user.selectOptions(select('State'), 'IN_DEV')
    expect(button('Save')).toBeEnabled()
    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ state: 'IN_DEV' })
  })

  it('AC-TSK-03 / D6: removing a task DELETEs it and returns to the sprint task list', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(designPath)
    await user.click(button('Remove'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Cart UI')
    expect(screen.queryByText('Design catalogue page')).toBeNull()
    expect(requests.some((r) => r.method === 'DELETE' && r.pathname === `${TASKS}/${taskId(1)}`)).toBe(true)
  })

  it('AC-TSK-03 / D14: a failed save notifies-current crud.task.save.error and keeps the edits', async () => {
    failNext('POST', TASKS, 500)
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a task...')).toHaveClass('alert alert-error')
    expect(rendered.router.state.location.pathname).toBe(newPath)
    expect(screen.getByLabelText('Name')).toHaveValue('Checkout button')
  })

  it('AC-TSK-03 / D14: a failed save of an existing task notifies-current crud.task.save.error', async () => {
    failNext('PUT', `${TASKS}/*`, 500)
    const { user, router } = await renderEdit(designPath)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a task...')).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(designPath)
  })

  it('AC-TSK-03 / D14: a failed remove notifies-current crud.task.remove.error and stays', async () => {
    failNext('DELETE', `${TASKS}/*`, 500)
    const { user, router } = await renderEdit(designPath)
    await user.click(button('Remove'))

    expect(await screen.findByText('Something went wrong when removing a task...')).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(designPath)
  })

  it('AC-TSK-03 / D14: the error is notify-current: it is gone after the next navigation', async () => {
    failNext('PUT', `${TASKS}/*`, 500)
    const { user, router } = await renderEdit(designPath)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))
    await screen.findByText('Something went wrong when saving a task...')

    await user.click(button('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Design catalogue page!')
    expect(screen.queryByText('Something went wrong when saving a task...')).toBeNull()
  })

  it('AC-TSK-02 / AC-API-04: an unknown task id shows "Route change error" and no form', async () => {
    await renderRoute(`${listPath}/${BACKLOG.deleted}`, { as: 'dev1' })
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
    expect(screen.queryByLabelText('Product Backlog item')).toBeNull()
  })

  it('P4: Enter in the Name field neither saves nor navigates, and the edits stay', async () => {
    const { user, router } = await renderEdit(designPath)
    await waitFor(() => expect(router.state.initialized).toBe(true))
    const name = screen.getByLabelText('Name')
    await user.type(name, ' v2')
    const requests = recordRequests()
    await user.type(name, '{Enter}')

    expect(name).toHaveValue('Design catalogue page v2')
    expect(requests).toEqual([])
    expect(router.state.location.pathname).toBe(designPath)
  })

  it('P4: a submit of the task form is cancelled (the browser would not reload the page)', async () => {
    const { form } = await renderEdit(designPath)
    const submits = watchSubmits()
    form.requestSubmit()
    expect(submits).toEqual([true])
  })
})
