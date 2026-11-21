// The MongoLab id shape (`_id: {$oid}`) exists only on the wire (spec §4, wire-quirk isolation rule).
// Feature code sees `id?: string`. Unknown fields are preserved, because a PUT replaces the whole document.

type WireRecord = Record<string, unknown>

function isRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `_id.$oid` (legacy `Resource.prototype.$id`). */
export function wireId(doc: WireRecord): string | undefined {
  const raw = doc._id
  return isRecord(raw) && typeof raw.$oid === 'string' ? raw.$oid : undefined
}

/** The `$in` operand for a list of ids (legacy `getByIds`). */
export function toOids(ids: readonly string[]): { $oid: string }[] {
  return ids.map((id) => ({ $oid: id }))
}

/**
 * Wire document → app document. The stub is the contract for each collection's shape, so only the
 * envelope is checked here; the cast names the collection type the caller asked for.
 */
export function fromWire<T>(raw: unknown): T {
  if (!isRecord(raw)) throw new TypeError('Expected a document object from the API')
  const doc: WireRecord = {}
  for (const [key, value] of Object.entries(raw)) if (key !== '_id') doc[key] = value
  const id = wireId(raw)
  if (id !== undefined) doc.id = id
  return doc as T
}

/** App document → wire body. `id` is dropped: legacy `$update` sent the document without `_id`. */
export function toWire(doc: object): WireRecord {
  const body: WireRecord = {}
  for (const [key, value] of Object.entries(doc)) if (key !== 'id') body[key] = value
  return body
}
