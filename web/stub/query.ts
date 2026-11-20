// The `?q=` grammar, exactly what live legacy code sends (owner answer C3, AC-STUB-07):
//   {}                                   all documents
//   {field: scalar, ...}                 equality, ANDed
//   {_id: {$in: [{$oid: "<hex>"}, ...]}} id membership (an empty list matches nothing)
// Anything else is rejected, so a worker can't come to depend on a query MongoLab-era code never sent.
import type { WireDoc } from './store.ts'

export type Predicate = (doc: WireDoc) => boolean
export type QueryResult = { ok: true; match: Predicate } | { ok: false; message: string }

type Scalar = string | number | boolean

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
  if (raw === undefined) return { ok: true, match: () => true }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'q is not valid JSON' }
  }
  if (!isPlainObject(parsed)) return { ok: false, message: 'q must be a JSON object' }

  const checks: Predicate[] = []
  for (const [field, value] of Object.entries(parsed)) {
    if (field === '_id') {
      const ids = parseIdIn(value)
      if (!ids) return { ok: false, message: 'only {_id: {$in: [{$oid}]}} is supported for _id' }
      checks.push((doc) => ids.includes(doc._id.$oid))
    } else if (field === 'password') {
      // Would let anyone test a guess against stored passwords (D7 hardening; no legacy code queries it).
      return { ok: false, message: 'querying password is not allowed' }
    } else if (field.startsWith('$')) {
      return { ok: false, message: `operator ${field} is not supported` }
    } else if (isScalar(value)) {
      checks.push((doc) => doc[field] === value)
    } else {
      return { ok: false, message: `unsupported condition on ${field}` }
    }
  }
  return { ok: true, match: (doc) => checks.every((check) => check(doc)) }
}
