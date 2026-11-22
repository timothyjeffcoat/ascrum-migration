import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { pushForCurrentRoute } from '../notifications/store.ts'
import { renderRoute, waitForShell } from '../test/renderRoute.tsx'

describe('NotificationsOutlet', () => {
  it('AC-NOT-03: one "alert alert-<type>" per notification, each with an x close button; not rendered when empty', async () => {
    const { router, user } = await renderRoute('/projectsinfo')
    await waitForShell(router) // the outlet lives in the shell, which re-mounts after the first load
    expect(document.querySelector('.alert')).toBeNull()
    const containersBefore = document.querySelectorAll('.container-fluid').length

    act(() => {
      pushForCurrentRoute('crud.user.save.success', 'success', { id: 'u1' })
      pushForCurrentRoute('crud.user.save.error', 'error')
    })

    const saved = screen.getByText("A user with id 'u1' was saved successfully.")
    const failed = screen.getByText('Something went wrong when saving a user...')
    expect(saved).toHaveClass('alert alert-success')
    expect(failed).toHaveClass('alert alert-error')
    expect(saved.parentElement).toHaveClass('container-fluid')
    expect(document.querySelectorAll('.container-fluid')).toHaveLength(containersBefore + 1)

    const close = within(saved).getByRole('button', { name: 'x' })
    expect(close).toHaveClass('close')
    await user.click(close)
    expect(screen.queryByText("A user with id 'u1' was saved successfully.")).toBeNull()

    await user.click(within(failed).getByRole('button', { name: 'x' }))
    expect(document.querySelector('.alert')).toBeNull()
    expect(document.querySelectorAll('.container-fluid')).toHaveLength(containersBefore)
  })
})
