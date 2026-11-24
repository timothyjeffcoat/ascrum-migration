// The `?q=` grammar, exactly what live legacy code sends (owner answer C3, AC-STUB-07):
//   {}                                   all documents
//   {field: scalar, ...}                 equality, ANDed
//   {_id: {$in: [{$oid: "<hex>"}, ...]}} id membership (an empty list matches nothing)
// Anything else is rejected, so a worker can't come to depend on a query MongoLab-era code never sent.
//
// Phase 5 (spec §3.2): the parser returns a structured query instead of a predicate. The memory store
// evaluates it with `matches()` below (the reference semantics); PgStore translates it to parameterised
// SQL. Both must mean exactly the same thing, and the shared contract tests check that they do.
import type { WireDoc } from './store.ts'

export type Scalar = string | number | boolean

export type Condition = { kind: 'eq'; field: string; value: Scalar } | { kind: 'idIn'; ids: string[] }

/** Conditions are ANDed; an empty list matches every document. */
export type Query = Condition[]

export type QueryResult = { ok: true; query: Query } | { ok: false; message: string }

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseIdIn(value: unknown): string[] | null {
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== '$in' || !Array.isArray(value.$in)) return null
  const ids: string[] = []
  for (const entry of value.$in) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 1 || typeof entry.$oid !== 'string') return null
    ids.push(entry.$oid)
  }
  return ids
}

export function parseQuery(raw: string | undefined): QueryResult {
  if (raw === undefined) return { ok: true, query: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'q is not valid JSON' }
  }
  if (!isPlainObject(parsed)) return { ok: false, message: 'q must be a JSON object' }

  const query: Query = []
  for (const [field, value] of Object.entries(parsed)) {
    if (field === '_id') {
      const ids = parseIdIn(value)
      if (!ids) return { ok: false, message: 'only {_id: {$in: [{$oid}]}} is supported for _id' }
      query.push({ kind: 'idIn', ids })
    } else if (field === 'password') {
      // Would let anyone test a guess against stored passwords (D7 hardening; no legacy code queries it).
      return { ok: false, message: 'querying password is not allowed' }
    } else if (field.startsWith('$')) {
      return { ok: false, message: `operator ${field} is not supported` }
    } else if (isScalar(value)) {
      query.push({ kind: 'eq', field, value })
    } else {
      return { ok: false, message: `unsupported condition on ${field}` }
    }
  }
  return { ok: true, query }
}

/** The reference semantics: strict equality (`===`, so 1 never matches "1") and id membership. */
export function matches(query: Query, doc: WireDoc): boolean {
  return query.every((condition) =>
    condition.kind === 'idIn' ? condition.ids.includes(doc._id.$oid) : doc[condition.field] === condition.value,
  )
}
