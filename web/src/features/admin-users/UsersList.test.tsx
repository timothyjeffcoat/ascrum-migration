// AC-USR-01..03 and legacy admin-users-list.spec, through the real app (renderRoute + MSW stub).
import { getDefaultNormalizer, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { failNext } from '../../test/stubControl.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'
import { USER } from '../../../stub/seed.ts'

const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const NOT_AUTHORIZED = 'You do not have the necessary access permissions.  Do you want to login as someone else?'
// The legacy message has two spaces; keep them when matching.
const EXACT = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }
const TABLE_CLASSES = 'table table-bordered table-condensed table-striped table-hover'

async function findTable(): Promise<HTMLElement> {
  return screen.findByRole('table')
}

/** The body rows (the header row excluded). */
function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1)
}

function rowFor(table: HTMLElement, email: string): HTMLElement {
  const row = within(table).getByText(email).closest('tr')
  if (!row) throw new Error(`no row for ${email}`)
  return row
}

describe('UsersList', () => {
  it('AC-USR-01: /admin/users requires admin: anonymous gets the login modal ("not authenticated")', async () => {
    const { router } = await renderRoute('/admin/users')
    expect(await screen.findByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
    expect(router.state.initialized).toBe(false)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('AC-USR-01: /admin/users requires admin: a non-admin gets the login modal ("not authorized")', async () => {
    await renderRoute('/admin/users', { as: 'dev1' })
    expect(await screen.findByText(NOT_AUTHORIZED, EXACT)).toHaveClass('alert alert-warning')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('AC-USR-01: columns are gravatar (50px, d=monsterid), E-mail, Last name, First name and a Remove button; legacy classes', async () => {
    const requests = recordRequests()
    await renderRoute('/admin/users', { as: 'admin' })
    const table = await findTable()

    expect(table).toHaveClass(TABLE_CLASSES, { exact: true })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['', 'E-mail', 'Last name', 'First name'])
    const rows = bodyRows(table)
    expect(rows).toHaveLength(6) // the seed's users
    // Legacy Users.all() → q={} (AC-API-03).
    expect(requests.find((r) => r.pathname.endsWith('/collections/users'))?.q).toEqual({})

    const po = rowFor(table, 'po@ascrum.test')
    const cells = within(po).getAllByRole('cell')
    expect(cells.map((td) => td.textContent)).toEqual(['', 'po@ascrum.test', 'Owner', 'Paula', 'Remove'])
    const img = within(cells[0] as HTMLElement).getByRole('img')
    expect(img.getAttribute('src')).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=50&d=monsterid$/)
    expect(within(po).getByRole('button', { name: 'Remove' })).toHaveClass('btn btn-danger remove', { exact: true })

    const newUser = screen.getByRole('button', { name: 'New User' })
    expect(newUser).toHaveClass('btn', { exact: true })
    expect(newUser.parentElement).toHaveClass('well')
  })

  it('admin-users-list.spec:10: the list shows the users the route loaded and has the list navigation', async () => {
    const { router, user } = await renderRoute('/admin/users', { as: 'admin' })
    const table = await findTable()
    for (const email of ['admin@abc.com', 'po@ascrum.test', 'sm@ascrum.test', 'dev1@ascrum.test']) {
      expect(within(table).getByText(email)).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: 'New User' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users/new'))
  })

  it('AC-USR-02: a row click opens /admin/users/:id; "New User" opens /admin/users/new', async () => {
    const { router, user } = await renderRoute('/admin/users', { as: 'admin' })
    const table = await findTable()
    await waitFor(() => expect(router.state.initialized).toBe(true))

    await user.click(within(rowFor(table, 'sm@ascrum.test')).getByText('Master'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/users/${USER.sm}`))
    expect(await screen.findByRole('textbox', { name: 'E-mail' })).toHaveValue('sm@ascrum.test')

    await router.navigate('/admin/users')
    await user.click(await screen.findByRole('button', { name: 'New User' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users/new'))
  })

  it('AC-USR-03: Remove does not open the row; on success the row disappears and a current-route notification shows', async () => {
    const requests = recordRequests()
    const { router, user } = await renderRoute('/admin/users', { as: 'admin' })
    const table = await findTable()
    await waitFor(() => expect(router.state.initialized).toBe(true))

    await user.click(within(rowFor(table, 'outsider@ascrum.test')).getByRole('button', { name: 'Remove' }))

    const notice = await screen.findByText(`A user with id '${USER.outsider}' was removed successfully.`)
    expect(notice).toHaveClass('alert alert-success')
    expect(within(table).queryByText('outsider@ascrum.test')).not.toBeInTheDocument()
    expect(bodyRows(table)).toHaveLength(5)
    expect(router.state.location.pathname).toBe('/admin/users') // no row navigation
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.pathname)).toEqual([
      `/databases/ascrum/collections/users/${USER.outsider}`,
    ])
  })

  it('AC-USR-03: a failed Remove keeps the row and shows crud.user.remove.error on the current route', async () => {
    const { router, user } = await renderRoute('/admin/users', { as: 'admin' })
    const table = await findTable()
    await waitFor(() => expect(router.state.initialized).toBe(true))
    failNext('DELETE', '/databases/ascrum/collections/users/*', 500)

    await user.click(within(rowFor(table, 'dev2@ascrum.test')).getByRole('button', { name: 'Remove' }))

    const notice = await screen.findByText(`Something went wrong when removing user with id '${USER.dev2}'.`)
    expect(notice).toHaveClass('alert alert-error')
    expect(within(table).getByText('dev2@ascrum.test')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/users')
  })
})
