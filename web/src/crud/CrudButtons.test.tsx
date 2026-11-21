import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CrudButtons } from './CrudButtons.tsx'

function formState(overrides: Partial<Parameters<typeof CrudButtons>[0]['form']> = {}) {
  return {
    canSave: false,
    canRevert: false,
    canRemove: false,
    save: vi.fn(),
    revert: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  }
}

describe('CrudButtons', () => {
  it('AC-CRUD-07: Save (btn btn-primary save) and Revert changes (btn btn-warning revert) are disabled unless allowed; Remove is not rendered without an id', () => {
    render(<CrudButtons form={formState()} />)
    const save = screen.getByRole('button', { name: 'Save' })
    const revert = screen.getByRole('button', { name: 'Revert changes' })
    expect(save).toHaveClass('btn btn-primary save')
    expect(revert).toHaveClass('btn btn-warning revert')
    expect(save).toBeDisabled()
    expect(revert).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('AC-CRUD-07: enabled buttons call save/revert/remove; Remove (btn btn-danger remove) shows when canRemove; all are type="button"', async () => {
    const form = formState({ canSave: true, canRevert: true, canRemove: true })
    render(<CrudButtons form={form} />)
    const user = userEvent.setup()

    const remove = screen.getByRole('button', { name: 'Remove' })
    expect(remove).toHaveClass('btn btn-danger remove')
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(screen.getByRole('button', { name: 'Revert changes' }))
    await user.click(remove)
    expect(form.save).toHaveBeenCalledOnce()
    expect(form.revert).toHaveBeenCalledOnce()
    expect(form.remove).toHaveBeenCalledOnce()
  })
})
