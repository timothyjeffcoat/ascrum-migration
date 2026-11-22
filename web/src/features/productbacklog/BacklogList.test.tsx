import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BACKLOG, PROJECT } from '../../../stub/seed.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'
import { failNext } from '../../test/stubControl.ts'

const webshopBacklog = `/projects/${PROJECT.webshop}/productbacklog`
const cleanupBacklog = `/projects/${PROJECT.legacyCleanup}/productbacklog`

describe('/projects/:projectId/productbacklog (BacklogList)', () => {
  it('AC-PBL-01: requires authentication (the login modal opens, nothing is fetched)', async () => {
    const requests = recordRequests()
    await renderRoute(webshopBacklog)
    expect(await screen.findByText('You must be logged in to access this part of the application.')).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
    expect(requests.some((r) => r.pathname.endsWith('/collections/productbacklog'))).toBe(false)
  })

  it('class parity: the legacy table classes and the "well" around the New button', async () => {
    await renderRoute(webshopBacklog, { as: 'dev1' })
    expect(await screen.findByRole('table')).toHaveClass(
      'table table-bordered table-condensed table-striped table-hover',
    )
    expect(screen.getByRole('button', { name: 'New backlog item' })).toHaveClass('btn')
    expect(screen.getByRole('button', { name: 'New backlog item' }).parentElement).toHaveClass('well')
  })

  it("AC-PBL-01: lists only the project's items with Name, Description, Priority, Estimation", async () => {
    const requests = recordRequests()
    await renderRoute(webshopBacklog, { as: 'dev1' })
    const table = await screen.findByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Description', 'Priority', 'Estimation'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(6) // Webshop's six seeded items, none of Mobile App's
    const first = rows[0]
    if (!first) throw new Error('no first row')
    expect(
      within(first)
        .getAllByRole('cell')
        .map((td) => td.textContent),
    ).toEqual(['Product catalogue', 'Browse products by category', '1', '5'])
    // Legacy ProductBacklog.forProject: query({projectId}).
    expect(requests.find((r) => r.pathname.endsWith('/collections/productbacklog'))?.q).toEqual({
      projectId: PROJECT.webshop,
    })
  })

  it('AC-PBL-01: empty state "No items in the backlog" spans the four columns', async () => {
    await renderRoute(cleanupBacklog, { as: 'admin' })
    const cell = await screen.findByText('No items in the backlog')
    expect(cell).toHaveAttribute('colspan', '4')
  })

  it('AC-PBL-01: a non-empty backlog has no empty-state row', async () => {
    await renderRoute(webshopBacklog, { as: 'dev1' })
    await screen.findByRole('table')
    expect(screen.queryByText('No items in the backlog')).toBeNull()
  })

  it('AC-PBL-01: a row click opens the edit page', async () => {
    const { user, router } = await renderRoute(webshopBacklog, { as: 'dev1' })
    await user.click(await screen.findByText('Shopping cart'))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${webshopBacklog}/${BACKLOG.cart}`))
    expect(await screen.findByLabelText('Name')).toHaveValue('Shopping cart')
  })

  it('AC-PBL-01: "New backlog item" opens the new page', async () => {
    const { user, router } = await renderRoute(webshopBacklog, { as: 'dev1' })
    await user.click(await screen.findByRole('button', { name: 'New backlog item' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${webshopBacklog}/new`))
    expect(await screen.findByRole('heading', { name: 'Product backlog item' })).toBeVisible()
  })

  it('AC-PBL-01 / AC-NOT-04: a failed backlog load shows "Route change error" inside the shell', async () => {
    failNext('GET', '/databases/ascrum/collections/productbacklog', 500)
    await renderRoute(webshopBacklog, { as: 'dev1' })
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
    expect(screen.queryByRole('table')).toBeNull()
  })
})
