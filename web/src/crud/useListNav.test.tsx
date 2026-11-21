import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { useListNav } from './useListNav.ts'

function ListWithNav() {
  const { onNew, onEdit } = useListNav('/prefix')
  return (
    <>
      <button type="button" onClick={onNew}>
        new
      </button>
      <button type="button" onClick={() => onEdit('someId')}>
        edit
      </button>
    </>
  )
}

function renderList() {
  const router = createMemoryRouter([{ path: '*', Component: ListWithNav }], { initialEntries: ['/prefix'] })
  render(<RouterProvider router={router} />)
  return { router, user: userEvent.setup() }
}

// Legacy common/services/crud.spec.js, "crud list methods".
describe('legacy crudListMethods cases', () => {
  it('should support new method', async () => {
    const { router, user } = renderList()
    await user.click(screen.getByRole('button', { name: 'new' }))
    expect(router.state.location.pathname).toBe('/prefix/new')
  })

  it('should support edit method', async () => {
    const { router, user } = renderList()
    await user.click(screen.getByRole('button', { name: 'edit' }))
    expect(router.state.location.pathname).toBe('/prefix/someId')
  })
})

describe('useListNav', () => {
  it('AC-CRUD-08: onNew → prefix/new; onEdit(id) → prefix/id', async () => {
    const { router, user } = renderList()
    await user.click(screen.getByRole('button', { name: 'edit' }))
    await user.click(screen.getByRole('button', { name: 'new' }))
    expect(router.state.location.pathname).toBe('/prefix/new')
    await router.navigate(-1)
    expect(router.state.location.pathname).toBe('/prefix/someId')
  })
})
