import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROJECT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'

const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
// The legacy string has a double space, which getByText's default normalizer collapses.
const NOT_AUTHORIZED = /^You do not have the necessary access permissions\. +Do you want to login as someone else\?$/

async function findListTable(): Promise<HTMLElement> {
  return (await screen.findByRole('columnheader', { name: 'Name' })).closest('table') as HTMLElement
}

describe('ProjectsAdminList (/admin/projects)', () => {
  it('AC-APR-01 / legacy :6: an admin sees every project in a Name/Description table with the legacy classes', async () => {
    const requests = recordRequests()
    await renderRoute('/admin/projects', { as: 'admin' })

    const table = await findListTable()
    expect(table).toHaveClass('table table-bordered table-condensed table-striped table-hover')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Description'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['Webshop', 'Online store rewrite'],
      ['Mobile App', 'Companion app for the webshop'],
      ['Legacy Cleanup', 'Retire the old intranet'],
    ])
    expect(screen.getByRole('button', { name: 'New Project' }).closest('div')).toHaveClass('well')
    // Legacy `Projects.all()`: q={}.
    expect(requests.find((r) => r.pathname === '/databases/ascrum/collections/projects')?.q).toEqual({})
  })

  it('AC-APR-01: a row click opens the project for editing; "New Project" opens /admin/projects/new', async () => {
    const { router, user } = await renderRoute('/admin/projects', { as: 'admin' })
    await findListTable()

    await user.click(screen.getByText('Mobile App'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/projects/${PROJECT.mobileApp}`))

    await router.navigate('/admin/projects')
    await user.click(await screen.findByRole('button', { name: 'New Project' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects/new'))
  })

  it('AC-APR-01: requires admin; a non-admin gets the "not authorized" login modal and no project list', async () => {
    const requests = recordRequests()
    await renderRoute('/admin/projects', { as: 'po' })

    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    expect(within(modal).getByText(NOT_AUTHORIZED)).toHaveClass('alert alert-warning')
    expect(screen.queryByRole('columnheader', { name: 'Name' })).not.toBeInTheDocument()
    // The guard runs before the loader fetches anything.
    expect(requests.some((r) => r.pathname.startsWith('/databases/'))).toBe(false)
  })

  it('AC-APR-01: an anonymous deep link asks for a login; logging in as admin completes the navigation', async () => {
    const { user } = await renderRoute('/admin/projects')

    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    expect(within(modal).getByText(NOT_AUTHENTICATED)).toBeInTheDocument()
    await user.type(within(modal).getByLabelText('E-mail'), 'admin@abc.com')
    await user.type(within(modal).getByLabelText('Password'), 'changeme')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    const table = await findListTable()
    expect(within(table).getByText('Webshop')).toBeInTheDocument()
  })
})
