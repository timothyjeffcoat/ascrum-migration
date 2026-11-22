import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BACKLOG, PROJECT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute, type RenderRouteResult } from '../../test/renderRoute.tsx'
import { failNext } from '../../test/stubControl.ts'
import { newBacklogItemDraft } from './BacklogItemEdit.tsx'

const listPath = `/projects/${PROJECT.webshop}/productbacklog`
const newPath = `${listPath}/new`
const cartPath = `${listPath}/${BACKLOG.cart}`
const COLLECTION = '/databases/ascrum/collections/productbacklog'

async function renderEdit(path: string): Promise<RenderRouteResult & { well: HTMLElement }> {
  const rendered = await renderRoute(path, { as: 'dev1' })
  const heading = await screen.findByRole('heading', { name: 'Product backlog item' })
  const well = heading.parentElement
  if (!well) throw new Error('no well')
  return { ...rendered, well }
}

const button = (name: string) => screen.getByRole('button', { name })

const NEW_ITEM = {
  Name: 'Gift cards',
  'User story': 'Customers can buy gift cards',
  Priority: '7',
  Estimation: '8',
}

async function fillNew({ user }: RenderRouteResult) {
  for (const [label, text] of Object.entries(NEW_ITEM)) await user.type(screen.getByLabelText(label), text)
}

describe('backlog item edit (BacklogItemEdit)', () => {
  it('AC-PBL-02: the new route requires authentication', async () => {
    await renderRoute(newPath)
    expect(await screen.findByText('You must be logged in to access this part of the application.')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Product backlog item' })).toBeNull()
  })

  it('AC-PBL-02: the edit route requires authentication (the item is not fetched)', async () => {
    const requests = recordRequests()
    await renderRoute(cartPath)
    expect(await screen.findByText('You must be logged in to access this part of the application.')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Product backlog item' })).toBeNull()
    expect(requests.some((r) => r.pathname.startsWith(COLLECTION))).toBe(false)
  })

  it('class parity: the form sits in a "well" with the legacy fields and the CRUD buttons', async () => {
    const { well } = await renderEdit(cartPath)
    expect(well).toHaveClass('well')
    expect(screen.getByLabelText('Name')).toHaveClass('span10')
    expect(screen.getByLabelText('User story')).toHaveClass('span10')
    expect(screen.getByLabelText('User story').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('Priority')).toHaveAttribute('type', 'number')
    expect(screen.getByLabelText('Estimation')).toHaveAttribute('type', 'number')
    expect(button('Save')).toHaveClass('btn btn-primary save')
    expect(
      within(well)
        .getAllByRole('button')
        .map((b) => b.getAttribute('type')),
    ).toEqual(['button', 'button', 'button'])
  })

  it('AC-PBL-02: the §5.6 draft is {projectId, name:"", desc:""}', () => {
    expect(newBacklogItemDraft('p1')).toEqual({ projectId: 'p1', name: '', desc: '' })
  })

  it('AC-PBL-02: a new item starts from the draft: empty fields, Save disabled, no Remove', async () => {
    await renderEdit(newPath)
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('User story')).toHaveValue('')
    expect(screen.getByLabelText('Priority')).toHaveValue(null)
    expect(screen.getByLabelText('Estimation')).toHaveValue(null)
    expect(button('Save')).toBeDisabled()
    expect(button('Revert changes')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('AC-PBL-02: Name, User story, Priority and Estimation are all required', async () => {
    const rendered = await renderEdit(newPath)
    const { user } = rendered
    await fillNew(rendered)
    expect(button('Save')).toBeEnabled()

    for (const [label, text] of Object.entries(NEW_ITEM)) {
      const field = screen.getByLabelText(label)
      await user.clear(field)
      expect(button('Save'), `${label} cleared`).toBeDisabled()
      await user.type(field, text)
      expect(button('Save'), `${label} restored`).toBeEnabled()
    }
  })

  it('AC-PBL-02 / AC-PBL-03: saving a new item POSTs numbers (numberFields) and returns to the backlog list', async () => {
    const requests = recordRequests()
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(button('Save'))

    await waitFor(() => expect(rendered.router.state.location.pathname).toBe(listPath))
    expect(await screen.findByText('Gift cards')).toBeVisible()
    const post = requests.find((r) => r.method === 'POST' && r.pathname === COLLECTION)
    expect(post?.body).toEqual({
      projectId: PROJECT.webshop,
      name: 'Gift cards',
      desc: 'Customers can buy gift cards',
      priority: 7,
      estimation: 8,
    })
  })

  it('AC-PBL-02: the edit route loads the item; Remove is offered', async () => {
    await renderEdit(cartPath)
    expect(screen.getByLabelText('Name')).toHaveValue('Shopping cart')
    expect(screen.getByLabelText('User story')).toHaveValue('Add, remove and update items')
    expect(screen.getByLabelText('Priority')).toHaveValue(2)
    expect(screen.getByLabelText('Estimation')).toHaveValue(8)
    expect(button('Save')).toBeDisabled() // not dirty
    expect(button('Remove')).toHaveClass('btn btn-danger remove')
  })

  it('AC-PBL-03: saving an existing item PUTs it and returns to the backlog list', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(cartPath)
    await user.clear(screen.getByLabelText('Estimation'))
    await user.type(screen.getByLabelText('Estimation'), '13')
    await user.click(button('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    const row = (await screen.findByText('Shopping cart')).closest('tr')
    if (!row) throw new Error('no row')
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('13')
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`${COLLECTION}/${BACKLOG.cart}`)
    expect(put?.body).toMatchObject({ projectId: PROJECT.webshop, name: 'Shopping cart', priority: 2, estimation: 13 })
  })

  it('AC-PBL-03: removing an item DELETEs it and returns to the backlog list', async () => {
    const requests = recordRequests()
    const { user, router } = await renderEdit(cartPath)
    await user.click(button('Remove'))

    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Product catalogue')
    expect(screen.queryByText('Shopping cart')).toBeNull()
    expect(requests.some((r) => r.method === 'DELETE' && r.pathname === `${COLLECTION}/${BACKLOG.cart}`)).toBe(true)
  })

  it('AC-PBL-03 / D14: a failed save of a new item notifies-current crud.backlogItem.save.error and stays', async () => {
    failNext('POST', COLLECTION, 500)
    const rendered = await renderEdit(newPath)
    await fillNew(rendered)
    await rendered.user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a backlog item...')).toHaveClass(
      'alert alert-error',
    )
    expect(rendered.router.state.location.pathname).toBe(newPath)
    expect(screen.getByLabelText('Name')).toHaveValue('Gift cards') // the user's input survives
  })

  it('AC-PBL-03 / D14: a failed save of an existing item notifies-current crud.backlogItem.save.error', async () => {
    failNext('PUT', `${COLLECTION}/*`, 500)
    const { user, router } = await renderEdit(cartPath)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))

    expect(await screen.findByText('Something went wrong when saving a backlog item...')).toHaveClass(
      'alert alert-error',
    )
    expect(router.state.location.pathname).toBe(cartPath)
  })

  it('AC-PBL-03 / D14: a failed remove notifies-current crud.backlogItem.remove.error and stays', async () => {
    failNext('DELETE', `${COLLECTION}/*`, 500)
    const { user, router } = await renderEdit(cartPath)
    await user.click(button('Remove'))

    expect(await screen.findByText('Something went wrong when removing a backlog item...')).toHaveClass(
      'alert alert-error',
    )
    expect(router.state.location.pathname).toBe(cartPath)
  })

  it('AC-PBL-03 / D14: the error is notify-current: it is gone after the next navigation', async () => {
    failNext('PUT', `${COLLECTION}/*`, 500)
    const { user, router } = await renderEdit(cartPath)
    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(button('Save'))
    await screen.findByText('Something went wrong when saving a backlog item...')

    await user.click(button('Remove'))
    await waitFor(() => expect(router.state.location.pathname).toBe(listPath))
    await screen.findByText('Product catalogue')
    expect(screen.queryByText('Something went wrong when saving a backlog item...')).toBeNull()
  })

  it('AC-PBL-02 / AC-API-04: an unknown item id shows "Route change error" and no form', async () => {
    await renderRoute(`${listPath}/${BACKLOG.deleted}`, { as: 'dev1' })
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
    expect(screen.queryByRole('heading', { name: 'Product backlog item' })).toBeNull()
  })
})

/**
 * P4: records `defaultPrevented` for every submit event that reaches window. The listener sits outside
 * React's root, so it sees each event after the form's onSubmit has run. jsdom never navigates on a
 * native submission, so a cancelled submit event is the only unit-level proof that the browser would
 * not reload the page (the reload itself is covered by e2e/forms-enter.spec.ts).
 */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

describe('backlog item edit: Enter in the form (P4)', () => {
  it('P4: Enter in the backlog item Name field keeps the edits and does not submit', async () => {
    const { user, router } = await renderEdit(cartPath)
    await waitFor(() => expect(router.state.initialized).toBe(true))
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(name).not.toHaveValue(''))
    const { pathname, search } = router.state.location
    await user.clear(name)
    await user.type(name, 'Renamed but unsaved')

    const requests = recordRequests()
    const submits = watchSubmits()
    await user.type(name, '{Enter}')
    // Priority and Estimation also block implicit submission, so a browser does not submit on Enter
    // here. Submit anyway, the way any other trigger would, to prove the form cancels it.
    const form = name instanceof HTMLInputElement ? name.form : null
    if (!form) throw new Error('Name is not an input in a form')
    form.requestSubmit()

    expect(submits).toEqual([true])
    expect(name).toHaveValue('Renamed but unsaved')
    expect(requests).toEqual([])
    expect(router.state.location).toMatchObject({ pathname, search })
  })
})
