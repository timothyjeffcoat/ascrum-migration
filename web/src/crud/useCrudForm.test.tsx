import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { deepEqual, useCrudForm, type AsyncValidator, type CrudFormOptions, type Validator } from './useCrudForm.ts'
import { equalsField, required } from './validators.ts'

type Doc = { id?: string; someVal?: string; count?: number; tags?: string[] }
type Extra = { repeat: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<CrudFormOptions<Doc, Extra>> = {}) {
  const opts = {
    initial: { someVal: 'original' } as Doc,
    extra: { repeat: '' },
    save: vi.fn((payload: Doc) => Promise.resolve({ ...payload, id: payload.id ?? 'new-id' })),
    remove: vi.fn((doc: Doc) => {
      void doc
      return Promise.resolve()
    }),
    onSave: vi.fn(),
    onRemove: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
  const hook = renderHook(() => useCrudForm<Doc, Extra>(opts))
  return { ...hook, opts }
}

const requiredSomeVal = { someVal: [required] }

// Legacy common/directives/crud/edit.spec.js
describe('legacy crud-edit directive cases', () => {
  describe('scope initialization', () => {
    it('requires a valid resource object', () => {
      // Adapted: legacy threw at link time when the resource lacked $saveOrUpdate/$id/$remove. The
      // types require `save`; a saved document without a `remove` option throws when removed.
      const { result } = setup({ initial: { id: 'd1' }, remove: undefined })
      expect(() => result.current.remove()).toThrow('a saved document needs the `remove` option')
    })

    it('should attach methods to the scope', () => {
      // Adapted: the hook returns the API; the getCssClasses assertion is dropped (§5.9, §9).
      const { result } = setup()
      for (const name of ['save', 'canSave', 'revert', 'canRevert', 'remove', 'canRemove', 'showError'] as const) {
        expect(result.current[name]).toBeDefined()
      }
    })

    it('should not modify the parent scope', () => {
      // Adapted: the hook keeps its own copies; the caller's `initial` is never mutated.
      const initial: Doc = { someVal: 'original', tags: ['a'] }
      const { result } = setup({ initial })
      act(() => result.current.setField('someVal', 'changed'))
      act(() => result.current.setField('tags', ['a', 'b']))
      expect(initial).toEqual({ someVal: 'original', tags: ['a'] })
    })
  })

  describe('save', () => {
    it('should call resource.$saveOrUpdate', () => {
      const { result, opts } = setup()
      act(() => result.current.save())
      expect(opts.save).toHaveBeenCalledOnce()
    })

    it('should call resource.$saveOrUpdate with scope callbacks if specified', async () => {
      // Adapted: the screen's onSave is called with the saved document.
      const { result, opts } = setup()
      act(() => result.current.save())
      await waitFor(() => expect(opts.onSave).toHaveBeenCalledWith({ someVal: 'original', id: 'new-id' }))
    })

    it('should call resource.$saveOrUpdate with attribute callbacks if specified', async () => {
      // Adapted: legacy's mock called every callback; here success → onSave, failure → onError('save').
      const { result, opts } = setup({ save: vi.fn(() => Promise.reject(new Error('nope'))) })
      act(() => result.current.save())
      await waitFor(() => expect(opts.onError).toHaveBeenCalledWith('save'))
      expect(opts.onSave).not.toHaveBeenCalled()
    })

    it('should update the "original" object', async () => {
      const { result } = setup({ save: vi.fn(() => Promise.resolve({ someVal: 'newValue' })) })
      act(() => result.current.setField('someVal', 'newValue'))
      expect(result.current.canSave).toBe(true)
      act(() => result.current.save())
      await waitFor(() => expect(result.current.canSave).toBe(false))
    })
  })

  describe('canSave', () => {
    it('should return true if the model is valid and different to the original', () => {
      const { result } = setup()
      expect(result.current.canSave).toBe(false)
      act(() => result.current.setField('someVal', 'different'))
      expect(result.current.canSave).toBe(true)
    })

    it('should return false if the model is invalid', () => {
      const { result } = setup({ validators: requiredSomeVal })
      expect(result.current.canSave).toBe(false)
      act(() => result.current.setField('someVal', ''))
      expect(result.current.canSave).toBe(false) // different but invalid
    })
  })

  describe('revertChanges', () => {
    it('should reset the resource to its original state', () => {
      const { result } = setup()
      const original = structuredClone(result.current.values)
      act(() => result.current.setField('someVal', 'different'))
      expect(result.current.values).not.toEqual(original)
      act(() => result.current.revert())
      expect(result.current.values).toEqual(original)
    })
  })

  describe('canRevert', () => {
    it('should return false if the model is same as the original', () => {
      const { result } = setup({ validators: { someVal: [() => 'required'] } }) // invalid from the start
      expect(result.current.canRevert).toBe(false)
    })

    it('should return true if the model is different to the original', () => {
      const { result } = setup({ validators: requiredSomeVal })
      act(() => result.current.setField('someVal', 'different'))
      expect(result.current.canRevert).toBe(true)
      act(() => result.current.setField('someVal', '')) // and invalid
      expect(result.current.canRevert).toBe(true)
    })
  })

  describe('remove', () => {
    it('scope.remove should call resource.$remove if resource.$id returns true', async () => {
      const { result, opts } = setup({ initial: { id: 'd1', someVal: 'x' } })
      act(() => result.current.remove())
      expect(opts.remove).toHaveBeenCalledWith({ id: 'd1', someVal: 'x' })
      await waitFor(() => expect(opts.onRemove).toHaveBeenCalledWith({ id: 'd1', someVal: 'x' }))
    })

    it('scope.remove should call resource.$remove with scope callbacks if specified', async () => {
      // Adapted (S4): success → the screen's onRemove (no fallback to onSave); failure → onError('remove').
      const { result, opts } = setup({
        initial: { id: 'd1' },
        remove: vi.fn(() => Promise.reject(new Error('nope'))),
      })
      act(() => result.current.remove())
      await waitFor(() => expect(opts.onError).toHaveBeenCalledWith('remove'))
      expect(opts.onRemove).not.toHaveBeenCalled()
      expect(opts.onSave).not.toHaveBeenCalled()
    })

    it('scope.remove should call resource.$remove if resource.$id returns false', () => {
      const { result, opts } = setup()
      act(() => result.current.remove())
      expect(opts.remove).not.toHaveBeenCalled()
    })
  })

  describe('showError', () => {
    it('should return false if no error is set', () => {
      const { result } = setup({ validators: requiredSomeVal })
      expect(result.current.showError('someVal', 'required')).toBe(false)
    })

    it('should return true if the specified error is set', () => {
      const { result } = setup({ validators: requiredSomeVal })
      act(() => result.current.setField('someVal', ''))
      expect(result.current.showError('someVal', 'required')).toBe(true)
      expect(result.current.showError('someVal', 'email')).toBe(false)
    })
  })
})

describe('useCrudForm', () => {
  it('AC-CRUD-01: original is a deep copy of initial; dirty = deep-unequal(values, original); extra is excluded', () => {
    const initial: Doc = { someVal: 'x', tags: ['a'] }
    const { result } = setup({ initial })
    expect(result.current.canRevert).toBe(false)

    act(() => result.current.setField('tags', ['a', 'b']))
    expect(result.current.canRevert).toBe(true)
    act(() => result.current.setField('tags', ['a']))
    expect(result.current.canRevert).toBe(false) // equal again, by value

    act(() => result.current.setExtra('repeat', 'typed'))
    expect(result.current.extra.repeat).toBe('typed')
    expect(result.current.canRevert).toBe(false)
    expect(initial.tags).toEqual(['a'])

    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true) // angular.equals semantics
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false)
  })

  it('AC-CRUD-02: canSave = no errors && !pending && dirty; canRevert = dirty; canRemove = has id', () => {
    const fresh = setup({ validators: requiredSomeVal })
    expect(fresh.result.current).toMatchObject({ canSave: false, canRevert: false, canRemove: false })
    act(() => fresh.result.current.setField('someVal', 'changed'))
    expect(fresh.result.current).toMatchObject({ canSave: true, canRevert: true, canRemove: false })
    act(() => fresh.result.current.setField('someVal', ''))
    expect(fresh.result.current).toMatchObject({ canSave: false, canRevert: true })

    const loaded = setup({ initial: { id: 'd1', someVal: 'x' } })
    expect(loaded.result.current.canRemove).toBe(true)
  })

  it('AC-CRUD-03: revert restores values and extra and reruns validation; errors still show if invalid', () => {
    const { result } = setup({
      initial: { someVal: '' },
      validators: { ...requiredSomeVal, repeat: [equalsField<Doc & Extra>('someVal')] },
    })
    expect(result.current.showError('someVal', 'required')).toBe(true) // a "new" form shows errors at once
    act(() => result.current.setField('someVal', 'abc'))
    act(() => result.current.setExtra('repeat', 'abc'))
    expect(result.current.errors).toEqual({})

    act(() => result.current.revert())
    expect(result.current.values).toEqual({ someVal: '' })
    expect(result.current.extra).toEqual({ repeat: '' })
    expect(result.current.showError('someVal', 'required')).toBe(true)
  })

  it('AC-CRUD-04: save success → original := the server result → onSave(result); failure → onError("save")', async () => {
    const order: string[] = []
    const { result, opts } = setup({
      save: vi.fn(() => Promise.resolve({ id: 's1', someVal: 'from server' })),
      onSave: vi.fn(() => order.push('onSave')),
    })
    act(() => result.current.setField('someVal', 'edited'))
    act(() => result.current.save())
    await waitFor(() => expect(opts.onSave).toHaveBeenCalledWith({ id: 's1', someVal: 'from server' }))
    // The new original is the server's document, so the edited values now differ from it.
    expect(result.current.canRevert).toBe(true)
    act(() => result.current.revert())
    expect(result.current.values).toEqual({ id: 's1', someVal: 'from server' })

    const failing = setup({ save: vi.fn(() => Promise.reject(new Error('500'))) })
    act(() => failing.result.current.save())
    await waitFor(() => expect(failing.opts.onError).toHaveBeenCalledWith('save'))
  })

  it('AC-CRUD-05: remove with an id → DELETE → onRemove; without an id → onRemove with no request; failure → onError("remove")', async () => {
    const saved = setup({ initial: { id: 'd1', someVal: 'x' } })
    act(() => saved.result.current.remove())
    expect(saved.opts.remove).toHaveBeenCalledOnce()
    await waitFor(() => expect(saved.opts.onRemove).toHaveBeenCalledWith({ id: 'd1', someVal: 'x' }))

    const draft = setup({ initial: { someVal: 'x' } })
    act(() => draft.result.current.remove())
    expect(draft.opts.remove).not.toHaveBeenCalled()
    expect(draft.opts.onRemove).toHaveBeenCalledWith({ someVal: 'x' })

    const failing = setup({ initial: { id: 'd1' }, remove: vi.fn(() => Promise.reject(new Error('500'))) })
    act(() => failing.result.current.remove())
    await waitFor(() => expect(failing.opts.onError).toHaveBeenCalledWith('remove'))
  })

  it('AC-CRUD-06: errors are visible whenever a field is invalid (no touched concept); showError reflects the current errors', () => {
    const { result } = setup({ initial: { someVal: '' }, validators: requiredSomeVal })
    // Nothing touched yet, and the error is already there (legacy R-08 parity).
    expect(result.current.errors).toEqual({ someVal: ['required'] })
    expect(result.current.showError('someVal', 'required')).toBe(true)
    act(() => result.current.setField('someVal', 'ok'))
    expect(result.current.showError('someVal', 'required')).toBe(false)
  })

  it('AC-CRUD-09: validators get (value, values, ctx); equalsField fails with "equal" and re-validates when the other field changes', () => {
    const seen = vi.fn<Validator<Doc & Extra>>(() => null)
    const { result } = setup({
      initial: { id: 'u1', someVal: 'secret' },
      validators: { someVal: [seen], repeat: [equalsField<Doc & Extra>('someVal')] },
    })
    expect(seen).toHaveBeenLastCalledWith(
      'secret',
      { id: 'u1', someVal: 'secret', repeat: '' },
      {
        isNew: false,
        originalId: 'u1',
      },
    )
    expect(result.current.showError('repeat', 'equal')).toBe(true)
    act(() => result.current.setExtra('repeat', 'secret'))
    expect(result.current.showError('repeat', 'equal')).toBe(false)
    act(() => result.current.setField('someVal', 'changed')) // the OTHER field changes
    expect(result.current.showError('repeat', 'equal')).toBe(true)

    const conditional = setup({ validators: { someVal: [(_v, _values, ctx) => (ctx.isNew ? 'onlyOnCreate' : null)] } })
    expect(conditional.result.current.errors).toEqual({ someVal: ['onlyOnCreate'] })
  })

  it('AC-CRUD-10: an async validator makes pending true and canSave false while in flight', async () => {
    const check = deferred<string | null>()
    const validator = vi.fn<AsyncValidator<Doc & Extra>>(() => check.promise)
    const { result } = setup({ asyncValidators: { someVal: validator } })

    act(() => result.current.setField('someVal', 'taken@x.com'))
    expect(validator).toHaveBeenCalledWith('taken@x.com', expect.objectContaining({ someVal: 'taken@x.com' }), {
      isNew: true,
    })
    expect(result.current.pending).toBe(true)
    expect(result.current.canSave).toBe(false)

    await act(async () => check.resolve('uniqueEmail'))
    expect(result.current.pending).toBe(false)
    expect(result.current.showError('someVal', 'uniqueEmail')).toBe(true)
    expect(result.current.canSave).toBe(false)
  })

  it('AC-CRUD-10 / S2: a stale async result (the value changed meanwhile) is ignored', async () => {
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    const validator = vi
      .fn<AsyncValidator<Doc & Extra>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = setup({ asyncValidators: { someVal: validator } })

    act(() => result.current.setField('someVal', 'a@x.com'))
    act(() => result.current.setField('someVal', 'b@x.com'))
    await act(async () => first.resolve('uniqueEmail')) // the answer for a@x.com arrives late
    expect(result.current.showError('someVal', 'uniqueEmail')).toBe(false)
    expect(result.current.pending).toBe(true) // still waiting for b@x.com

    await act(async () => second.resolve(null))
    expect(result.current.pending).toBe(false)
    expect(result.current.canSave).toBe(true)
  })

  it("AC-CRUD-11: numberFields turn '3' into 3, and '' into undefined, which fails required", () => {
    const { result } = setup({ numberFields: ['count'], validators: { count: [required] } })
    act(() => result.current.setField('count', '3'))
    expect(result.current.values.count).toBe(3)
    expect(result.current.errors).toEqual({})
    act(() => result.current.setField('count', ''))
    expect(result.current.values.count).toBeUndefined()
    expect(result.current.showError('count', 'required')).toBe(true)
    act(() => result.current.setField('count', 'abc'))
    expect(result.current.showError('count', 'number')).toBe(true)
  })

  it('AC-CRUD-12: the toPayload output is what gets saved; extra never reaches the payload; undefined keys are omitted', async () => {
    const save = vi.fn((payload: Doc) => Promise.resolve(payload))
    const toPayload = vi.fn((values: Doc, extra: Extra) => ({
      ...values,
      someVal: `${values.someVal}+${extra.repeat}`,
    }))
    const { result, opts } = setup({ initial: { someVal: 'v', count: 1 }, numberFields: ['count'], save, toPayload })
    act(() => result.current.setExtra('repeat', 'r'))
    act(() => result.current.setField('count', ''))
    act(() => result.current.save())

    expect(toPayload).toHaveBeenCalledWith({ someVal: 'v', count: undefined }, { repeat: 'r' }, { isNew: true })
    expect(save).toHaveBeenCalledWith({ someVal: 'v+r' })
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('repeat')
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('count')
    await waitFor(() => expect(opts.onSave).toHaveBeenCalledWith({ someVal: 'v+r' }))
  })
})

// P6 / DSC-B-1: AngularJS 1.2's ngTrim trimmed the model value of every text input and textarea, while
// the input kept showing what was typed (its view value).
describe('P6 trimming', () => {
  it('P6 / DSC-B-1: a spaces-only required field is invalid, "  x  " saves as "x", and viewValue shows the raw text', async () => {
    const { result, opts } = setup({ initial: { someVal: '' }, validators: requiredSomeVal })
    act(() => result.current.setField('someVal', '   '))
    expect(result.current.values.someVal).toBe('')
    expect(result.current.viewValue('someVal')).toBe('   ')
    expect(result.current.showError('someVal', 'required')).toBe(true)
    expect(result.current.canSave).toBe(false)

    act(() => result.current.setField('someVal', '  x  '))
    expect(result.current.values.someVal).toBe('x')
    expect(result.current.viewValue('someVal')).toBe('  x  ')
    expect(result.current.canSave).toBe(true)
    act(() => result.current.save())
    expect(opts.save).toHaveBeenCalledWith({ someVal: 'x' })
    await waitFor(() => expect(opts.onSave).toHaveBeenCalled())
  })

  it('P6 / DSC-B-1: typing "a b" keystroke by keystroke keeps the inner space; a trailing space is shown but is not a change', () => {
    const { result } = setup({ initial: { someVal: 'a' } })
    act(() => result.current.setField('someVal', 'a '))
    // Legacy: the trimmed model value is still 'a', so the form is not dirty.
    expect(result.current.viewValue('someVal')).toBe('a ')
    expect(result.current.values.someVal).toBe('a')
    expect(result.current.canRevert).toBe(false)
    expect(result.current.canSave).toBe(false)
    act(() => result.current.setField('someVal', 'a b'))
    expect(result.current.viewValue('someVal')).toBe('a b')
    expect(result.current.values.someVal).toBe('a b')
    expect(result.current.canSave).toBe(true)
  })

  it('P6 / DSC-B-1: revert shows the original text unless the typed text already trims to it (AngularJS re-rendered only changed models)', () => {
    const { result } = setup({ initial: { someVal: 'orig', count: 1 }, numberFields: ['count'] })
    act(() => result.current.setField('someVal', ' changed '))
    act(() => result.current.revert())
    expect(result.current.values.someVal).toBe('orig')
    expect(result.current.viewValue('someVal')).toBe('orig')

    act(() => result.current.setField('someVal', 'orig  '))
    act(() => result.current.setField('count', '2'))
    act(() => result.current.revert())
    expect(result.current.values).toEqual({ someVal: 'orig', count: 1 })
    expect(result.current.viewValue('someVal')).toBe('orig  ')
    expect(result.current.canRevert).toBe(false)
  })

  it('P6 / DSC-B-1: extra text is trimmed too, so equalsField compares trimmed values; numbers and non-strings are untouched', () => {
    const { result } = setup({
      initial: { someVal: '', tags: [] },
      numberFields: ['count'],
      validators: { repeat: [equalsField<Doc & Extra>('someVal')] },
    })
    act(() => result.current.setField('someVal', 'pw'))
    act(() => result.current.setExtra('repeat', ' pw '))
    expect(result.current.extra.repeat).toBe('pw')
    expect(result.current.viewValue('repeat')).toBe(' pw ')
    expect(result.current.showError('repeat', 'equal')).toBe(false)

    act(() => result.current.setField('count', ' 3 '))
    expect(result.current.values.count).toBe(3)
    const tags = [' a ']
    act(() => result.current.setField('tags', tags))
    expect(result.current.values.tags).toBe(tags)
  })

  it('P6 / DSC-B-1: a trailing space does not restart an async check (legacy re-validated only a changed model)', async () => {
    const check = vi.fn<AsyncValidator<Doc & Extra>>(() => Promise.resolve(null))
    const { result } = setup({ asyncValidators: { someVal: check } })
    act(() => result.current.setField('someVal', 'x'))
    await waitFor(() => expect(result.current.pending).toBe(false))
    act(() => result.current.setField('someVal', 'x '))
    expect(check).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })
})
