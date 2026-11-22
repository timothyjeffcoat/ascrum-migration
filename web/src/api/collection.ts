// Port of vendor/mongolab/mongolab-resource.js. Returns plain typed objects instead of Resource
// instances; the prototype methods became pure functions in domain/ (spec §4).
// Node-style success/error callbacks are not ported: every caller uses the promise.
import { ApiError, isApiError } from './errors.ts'
import { request } from './http.ts'
import { fromWire, toOids, toWire } from './ids.ts'
import type { Draft } from './types.ts'

export type CollectionName = 'users' | 'projects' | 'productbacklog' | 'sprints' | 'tasks'
export type Query = Record<string, unknown>

/** Legacy MONGOLAB_CONFIG: baseUrl '/databases/' + dbName 'ascrum'. */
const BASE_URL = '/databases/ascrum/collections/'

export type Collection<T extends { id?: string }> = {
  /** Legacy `all()` sent `q={}`, and so does this (AC-API-03). */
  all(): Promise<T[]>
  query(q: Query): Promise<T[]>
  /** Rejects with `ApiError{code:'resource.notfound'}` on a 404 (C2, AC-API-04). */
  getById(id: string): Promise<T>
  /** Sends `{_id:{$in:[{$oid}…]}}`, also for an empty list (AC-API-05). */
  getByIds(ids: readonly string[]): Promise<T[]>
  /** POST when the document has no id, otherwise PUT to `/<id>` without the id (AC-API-06). */
  save(doc: Draft<T>): Promise<T>
  remove(doc: Draft<T>): Promise<void>
}

function toList<T>(body: unknown): T[] {
  if (!Array.isArray(body)) throw new TypeError('Expected a list of documents from the API')
  return body.map((item) => fromWire<T>(item))
}

export function collection<T extends { id?: string }>(name: CollectionName): Collection<T> {
  const url = BASE_URL + name
  const docUrl = (id: string) => `${url}/${encodeURIComponent(id)}`

  const query = async (q: Query): Promise<T[]> =>
    toList<T>(await request('GET', url, { query: { q: JSON.stringify(q) } }))

  return {
    all: () => query({}),
    query,
    async getById(id) {
      try {
        return fromWire<T>(await request('GET', docUrl(id)))
      } catch (error) {
        // C2: the stub answers 404 where MongoLab answered the body " null ".
        if (isApiError(error) && error.status === 404) {
          throw new ApiError(404, { code: 'resource.notfound', collection: name, body: error.body })
        }
        throw error
      }
    },
    getByIds: (ids) => query({ _id: { $in: toOids(ids) } }),
    async save(doc) {
      const body = toWire(doc)
      const saved =
        doc.id === undefined ? await request('POST', url, { body }) : await request('PUT', docUrl(doc.id), { body })
      return fromWire<T>(saved)
    },
    async remove(doc) {
      if (doc.id === undefined) throw new TypeError(`Cannot remove a ${name} document that has no id`)
      await request('DELETE', docUrl(doc.id))
    },
  }
}
