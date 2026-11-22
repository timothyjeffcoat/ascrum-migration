// Port of directives/crud/edit.js (crudEdit) as a hook, per the spec §4.2 contract that clusters 1–4
// consume. What the directive got from AngularJS forms (validity per field, `$error` keys) is computed
// here from plain validator functions.
//
// Rules (spec §4.2):
// - Validation runs on every change, and errors are visible whenever a field is invalid: there is no
//   "touched" concept (legacy parity).
// - canSave = no errors && !pending && dirty; dirty = deep-unequal(values, original); `extra` is never
//   dirty and never saved.
// - An async validator's result is applied only if the field is unchanged since it started (S2).
// - The form state starts from `initial` once. A screen that can switch documents without unmounting
//   should key the form by document id.
import { useRef, useState } from 'react'
import type { Draft } from '../api/types.ts'

export type ErrorKey = string
export type Ctx = { isNew: boolean; originalId?: string }
export type Validator<V> = (value: unknown, values: V, ctx: Ctx) => ErrorKey | null
export type AsyncValidator<V> = (value: unknown, values: V, ctx: Ctx) => Promise<ErrorKey | null>

export type CrudFormOptions<T extends object, X extends object> = {
  /** The loaded document or the §5.6 draft; deep-copied as `original`. */
  initial: Draft<T>
  /** Form-only fields (password repeat, selected team member): never saved, never dirty. */
  extra?: X
  validators?: Partial<Record<keyof T | keyof X, Validator<Draft<T> & X>[]>>
  asyncValidators?: Partial<Record<keyof T | keyof X, AsyncValidator<Draft<T> & X>>>
  /** Input string → number; '' → undefined (AngularJS `type="number"` parity). */
  numberFields?: (keyof T)[]
  toPayload?: (values: Draft<T>, extra: X, ctx: Ctx) => Draft<T>
  save: (payload: Draft<T>) => Promise<T>
  remove?: (doc: T) => Promise<void>
  onSave: (saved: T) => void
  /** S4: there is no fallback to onSave; each screen passes its own. */
  onRemove?: (doc: Draft<T>) => void
  onError: (op: 'save' | 'remove') => void
}

export type CrudForm<T extends object, X extends object> = {
  values: Draft<T>
  extra: X
  setField(name: keyof T, raw: unknown): void
  setExtra(name: keyof X, raw: unknown): void
  errors: Partial<Record<string, ErrorKey[]>>
  showError(field: string, key: ErrorKey): boolean
  /** Any async validator in flight. */
  pending: boolean
  canSave: boolean
  canRevert: boolean
  canRemove: boolean
  save(): void
  revert(): void
  remove(): void
}

type Flags = Readonly<Partial<Record<string, true>>>

export function useCrudForm<T extends object, X extends object = Record<never, never>>(
  opts: CrudFormOptions<T, X>,
): CrudForm<T, X> {
  // AC-CRUD-01: `original` is a deep copy of `initial`; so are the edited values.
  const [start] = useState(() => ({
    original: structuredClone(opts.initial),
    values: structuredClone(opts.initial),
    extra: structuredClone(opts.extra ?? emptyExtra<X>()),
    initialExtra: structuredClone(opts.extra ?? emptyExtra<X>()),
  }))
  const [original, setOriginal] = useState<Draft<T>>(start.original)
  const [values, setValues] = useState<Draft<T>>(start.values)
  const [extra, setExtraState] = useState<X>(start.extra)
  const [asyncErrors, setAsyncErrors] = useState<Partial<Record<string, ErrorKey>>>({})
  const [pendingFields, setPendingFields] = useState<Flags>({})
  const [unparsable, setUnparsable] = useState<Flags>({})

  // The latest values, for handlers and async callbacks that run before the next render. Every
  // change goes through the functions below, which update this first and then the state.
  const latest = useRef({ values: start.values, extra: start.extra, original: start.original })
  const asyncSeq = useRef<Record<string, number>>({})

  const ctxFor = (doc: Draft<T>): Ctx => {
    const originalId = idOf(doc)
    return originalId === undefined ? { isNew: true } : { isNew: false, originalId }
  }
  const ctx = ctxFor(original)

  // --- validation, every render ---------------------------------------------------------------
  const merged = { ...values, ...extra }
  const errors: Record<string, ErrorKey[]> = {}
  const addError = (field: string, key: ErrorKey) => {
    const list = (errors[field] ??= [])
    if (!list.includes(key)) list.push(key)
  }
  for (const [field, list] of fieldEntries(opts.validators)) {
    for (const validator of list) {
      const key = validator(readField(merged, field), merged, ctx)
      if (key) addError(field, key)
    }
  }
  for (const field of Object.keys(unparsable)) addError(field, 'number')
  for (const [field, key] of Object.entries(asyncErrors)) if (key) addError(field, key)

  const pending = Object.keys(pendingFields).length > 0
  const dirty = !deepEqual(values, original)

  // --- async validation -------------------------------------------------------------------------
  function startAsync(field: string, value: unknown, nextMerged: Draft<T> & X, docCtx: Ctx) {
    const validator = asyncValidatorFor(opts.asyncValidators, field)
    if (!validator) return
    const seq = (asyncSeq.current[field] ?? 0) + 1
    asyncSeq.current[field] = seq
    setAsyncErrors((prev) => without(prev, field))
    setPendingFields((prev) => ({ ...prev, [field]: true }))

    const apply = (result: ErrorKey | null) => {
      // S2/D9: a response for a value the user has since changed is stale and discarded.
      const { values: nowValues, extra: nowExtra } = latest.current
      const unchanged = Object.is(readField({ ...nowValues, ...nowExtra }, field), value)
      if (asyncSeq.current[field] !== seq || !unchanged) return
      setAsyncErrors((prev) => (result ? { ...prev, [field]: result } : without(prev, field)))
      setPendingFields((prev) => without(prev, field))
    }
    // A failed check (e.g. a network error) leaves the field valid rather than stuck pending.
    validator(value, nextMerged, docCtx).then(apply, () => apply(null))
  }

  // --- the API ----------------------------------------------------------------------------------
  function setField(name: keyof T, raw: unknown) {
    const field = String(name)
    let value = raw
    if (opts.numberFields?.includes(name)) {
      const parsed = parseNumber(raw)
      value = parsed.value
      setUnparsable((prev) => (parsed.invalid ? { ...prev, [field]: true } : without(prev, field)))
    }
    const nextValues: Draft<T> = { ...latest.current.values, [field]: value }
    latest.current = { ...latest.current, values: nextValues }
    setValues(nextValues)
    startAsync(field, value, { ...nextValues, ...latest.current.extra }, ctxFor(latest.current.original))
  }

  function setExtra(name: keyof X, raw: unknown) {
    const field = String(name)
    const nextExtra: X = { ...latest.current.extra, [field]: raw }
    latest.current = { ...latest.current, extra: nextExtra }
    setExtraState(nextExtra)
    startAsync(field, raw, { ...latest.current.values, ...nextExtra }, ctxFor(latest.current.original))
  }

  function save() {
    const { values: nowValues, extra: nowExtra, original: nowOriginal } = latest.current
    const docCtx = ctxFor(nowOriginal)
    const payload = withoutUndefined(opts.toPayload ? opts.toPayload(nowValues, nowExtra, docCtx) : nowValues)
    opts.save(payload).then(
      (saved) => {
        // AC-CRUD-04: the server's result becomes the new original, then the screen's onSave runs.
        latest.current = { ...latest.current, original: saved }
        setOriginal(saved)
        opts.onSave(saved)
      },
      () => opts.onError('save'),
    )
  }

  function revert() {
    // Legacy reverted the model and setPristine(); validation reruns, so errors may still show.
    const restored = structuredClone(latest.current.original)
    const restoredExtra = structuredClone(start.initialExtra)
    latest.current = { ...latest.current, values: restored, extra: restoredExtra }
    setValues(restored)
    setExtraState(restoredExtra)
    // In-flight async checks belong to values that are gone; restored values are the loaded ones.
    for (const field of Object.keys(asyncSeq.current)) asyncSeq.current[field] = (asyncSeq.current[field] ?? 0) + 1
    setAsyncErrors({})
    setPendingFields({})
    setUnparsable({})
  }

  function remove() {
    const doc = latest.current.values
    if (idOf(doc) === undefined) {
      // AC-CRUD-05: nothing saved yet, so nothing to DELETE.
      opts.onRemove?.(doc)
      return
    }
    if (!opts.remove) throw new Error('useCrudForm: a saved document needs the `remove` option')
    // The document has an id, so it was loaded from (or saved to) the API: a full T, not a draft.
    opts.remove(doc as T).then(
      () => opts.onRemove?.(doc),
      () => opts.onError('remove'),
    )
  }

  return {
    values,
    extra,
    setField,
    setExtra,
    errors,
    showError: (field, key) => errors[field]?.includes(key) ?? false,
    pending,
    canSave: Object.keys(errors).length === 0 && !pending && dirty,
    canRevert: dirty,
    canRemove: idOf(values) !== undefined,
    save,
    revert,
    remove,
  }
}

// --- helpers ----------------------------------------------------------------------------------------

function emptyExtra<X extends object>(): X {
  // Only reached when the screen declares no `extra`, so X is the default empty record type.
  return {} as X
}

function idOf(doc: object): string | undefined {
  return 'id' in doc && typeof doc.id === 'string' ? doc.id : undefined
}

function readField(doc: object, field: string): unknown {
  return Object.getOwnPropertyDescriptor(doc, field)?.value
}

function fieldEntries<V>(record: Partial<Record<PropertyKey, V>> | undefined): [string, V][] {
  const entries: [string, V][] = []
  for (const [field, value] of Object.entries(record ?? {})) if (value !== undefined) entries.push([field, value])
  return entries
}

function asyncValidatorFor<V>(
  validators: Partial<Record<PropertyKey, AsyncValidator<V>>> | undefined,
  field: string,
): AsyncValidator<V> | undefined {
  return validators?.[field]
}

function without<V>(record: Readonly<Partial<Record<string, V>>>, field: string): Partial<Record<string, V>> {
  const copy = { ...record }
  Reflect.deleteProperty(copy, field)
  return copy
}

/** §5.6: `undefined` keys (blank numbers and selects) are left out of the payload. */
function withoutUndefined<P extends object>(payload: P): P {
  const copy = { ...payload }
  for (const [key, value] of Object.entries(copy)) if (value === undefined) Reflect.deleteProperty(copy, key)
  return copy
}

function parseNumber(raw: unknown): { value: number | undefined; invalid: boolean } {
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? { value: raw, invalid: false } : { value: undefined, invalid: true }
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: undefined, invalid: false }
  const value = Number(raw)
  return Number.isFinite(value) ? { value, invalid: false } : { value: undefined, invalid: true }
}

/**
 * angular.equals semantics for plain data: deep, arrays by position, and a property set to undefined
 * equals a missing one (so a cleared number field is not "dirty" against a draft without it).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (!deepEqual(readField(a, key), readField(b, key))) return false
  return true
}
