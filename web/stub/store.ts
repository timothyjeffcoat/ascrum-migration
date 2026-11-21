// In-memory MongoLab stand-in: five collections of wire documents (`_id: {$oid}`), spec §7.
import { seedCollections } from './seed.ts'

export type Oid = { $oid: string }
export type WireDoc = { _id: Oid; [field: string]: unknown }

export const DB_NAME = 'ascrum'
export const COLLECTIONS = ['users', 'projects', 'productbacklog', 'sprints', 'tasks'] as const
export type CollectionName = (typeof COLLECTIONS)[number]

export type Store = {
  collections: Record<CollectionName, WireDoc[]>
  nextId: number
}

export function isCollection(name: string): name is CollectionName {
  return (COLLECTIONS as readonly string[]).includes(name)
}

export function createStore(): Store {
  return { collections: seedCollections(), nextId: 1 }
}

/** Reseed in place, so every holder of this store sees the reset (AC-STUB-14/15). */
export function resetStore(store: Store): void {
  const fresh = createStore()
  store.collections = fresh.collections
  store.nextId = fresh.nextId
}

/** 24-hex ids from a counter: deterministic after a reset (AC-STUB-15). Seed ids never start with "f". */
export function newId(store: Store): string {
  const id = 'f' + store.nextId.toString(16).padStart(23, '0')
  store.nextId += 1
  return id
}

export function findById(store: Store, c: CollectionName, id: string): WireDoc | undefined {
  return store.collections[c].find((doc) => doc._id.$oid === id)
}
