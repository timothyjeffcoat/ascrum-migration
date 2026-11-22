import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCrudForm } from './useCrudForm.ts'
import { email, equalsField, isEmail, required } from './validators.ts'

type Model = { compareTo?: string }
type Extra = { testValue: string }

/** The legacy fixture: `testInput` (ng-model testValue) with validate-equals="model.compareTo". */
function renderEqualsForm() {
  return renderHook(() =>
    useCrudForm<Model, Extra>({
      initial: { compareTo: '' },
      extra: { testValue: '' },
      validators: { testValue: [equalsField<Model & Extra>('compareTo')] },
      save: vi.fn(),
      onSave: vi.fn(),
      onError: vi.fn(),
    }),
  )
}

// Legacy app/admin/users/validateEquals.spec.js (cluster 0 owns validateEquals, spec §9).
describe('legacy validateEquals directive cases', () => {
  it('should be valid initially', () => {
    const { result } = renderEqualsForm()
    expect(result.current.showError('testValue', 'equal')).toBe(false)
  })

  it('should be invalid if the model changes', () => {
    const { result } = renderEqualsForm()
    act(() => result.current.setExtra('testValue', 'different'))
    expect(result.current.showError('testValue', 'equal')).toBe(true)
  })

  it('should be invalid if the reference model changes', () => {
    const { result } = renderEqualsForm()
    act(() => result.current.setField('compareTo', 'different'))
    expect(result.current.showError('testValue', 'equal')).toBe(true)
  })

  it('should be valid if the model changes to be the same as the reference', () => {
    const { result } = renderEqualsForm()
    act(() => result.current.setField('compareTo', 'different'))
    expect(result.current.showError('testValue', 'equal')).toBe(true)
    act(() => result.current.setExtra('testValue', 'different'))
    expect(result.current.showError('testValue', 'equal')).toBe(false)
  })
})

describe('validators', () => {
  it('AC-CRUD-09: equalsField(name) fails with "equal" against the other field', () => {
    const repeat = equalsField<{ password: string; passwordRepeat: string }>('password')
    const ctx = { isNew: true }
    expect(repeat('a', { password: 'a', passwordRepeat: 'a' }, ctx)).toBeNull()
    expect(repeat('b', { password: 'a', passwordRepeat: 'b' }, ctx)).toBe('equal')
  })

  it('required fails for undefined, null, empty string and NaN (AngularJS $isEmpty)', () => {
    expect([undefined, null, '', Number.NaN].map(required)).toEqual(['required', 'required', 'required', 'required'])
    expect([0, 'x', false, []].map(required)).toEqual([null, null, null, null])
  })

  it('email uses the AngularJS 1.2 EMAIL_REGEXP and leaves empty values to required', () => {
    expect(email('')).toBeNull()
    expect(email('po@ascrum.test')).toBeNull()
    expect(email('po@ascrum')).toBe('email')
    expect(isEmail('a.b+c@example.co.uk')).toBe(true)
    expect(isEmail('no-at-sign')).toBe(false)
  })
})
