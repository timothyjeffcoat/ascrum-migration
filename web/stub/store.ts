// The store behind handle() (spec §3.1, Phase 5): an interface with two implementations.
//   - MemoryStore (here): the original in-memory MongoLab stand-in. Unit tests, `pnpm dev`, the MSW
//     stub (`pnpm dev:msw`, the Pages demo) and Playwright use it.
//   - PgStore (api/src/pgStore.ts): PostgreSQL, for the real API.
// Both hold the five collections as wire documents (`_id: {$oid}`) and must behave identically; the
// contract tests in contractTests.ts run against both.
import { matches, type Query } from './query.ts'
import { seedCollections } from './seed.ts'

export type Oid = { $oid: string }
export type WireDoc = { _id: Oid; [field: string]: unknown }
/** A document body as a client sends it: any JSON object; its `_id` is ignored. */
export type Fields = Record<string, unknown>

export const DB_NAME = 'ascrum'
export const COLLECTIONS = ['users', 'projects', 'productbacklog', 'sprints', 'tasks'] as const
export type CollectionName = (typeof COLLECTIONS)[number]

export function isCollection(name: string): name is CollectionName {
  return (COLLECTIONS as readonly string[]).includes(name)
}

/**
 * What handle() needs from a store. Documents come back whole (users with their password); handle()
 * strips what must not go out (D7). Order matters: list() returns documents in insertion order, and a
 * replace keeps a document's place, as the in-memory arrays always did.
 */
export interface Store {
  list(c: CollectionName, query: Query): Promise<WireDoc[]>
  get(c: CollectionName, id: string): Promise<WireDoc | undefined>
  /** Stores `fields` under a new id from the deterministic counter (AC-STUB-15). */
  insert(c: CollectionName, fields: Fields): Promise<WireDoc>
  /** Replaces the whole document (fields left out are gone); undefined when there is no such id. */
  replace(c: CollectionName, id: string, fields: Fields): Promise<WireDoc | undefined>
  /** Deletes and returns the document; undefined when there is no such id. */
  remove(c: CollectionName, id: string): Promise<WireDoc | undefined>
  /** Every user with exactly this email, in insertion order (login picks the first password match). */
  usersByEmail(email: string): Promise<WireDoc[]>
  /** Reseeds: the seed documents only, and the id counter back to its start (AC-STUB-14/15). */
  reset(): Promise<void>
}

/** A value this store cannot keep (PgStore: a NUL character or a lone surrogate). handle() answers 400. */
export class UnstorableValueError extends Error {}

/** 24-hex ids from a counter: deterministic after a reset (AC-STUB-15). Seed ids never start with "f". */
export function idFromCounter(n: number): string {
  return 'f' + n.toString(16).padStart(23, '0')
}

export class MemoryStore implements Store {
  // Public on purpose: a few component tests seed scenarios by editing these arrays directly
  // ("seeding, not mocking"), which only the in-memory store can offer.
  collections: Record<CollectionName, WireDoc[]> = seedCollections()
  nextId = 1

  /** Synchronous reset, for the Vitest helpers that reset between (synchronous) steps. */
  reseed(): void {
    this.collections = seedCollections()
    this.nextId = 1
  }

  async list(c: CollectionName, query: Query): Promise<WireDoc[]> {
    return this.collections[c].filter((doc) => matches(query, doc))
  }

  async get(c: CollectionName, id: string): Promise<WireDoc | undefined> {
    return findById(this, c, id)
  }

  async insert(c: CollectionName, fields: Fields): Promise<WireDoc> {
    const created: WireDoc = { ...structuredClone(fields), _id: { $oid: idFromCounter(this.nextId) } }
    this.nextId += 1
    this.collections[c].push(created)
    return created
  }

  async replace(c: CollectionName, id: string, fields: Fields): Promise<WireDoc | undefined> {
    const docs = this.collections[c]
    const index = docs.findIndex((doc) => doc._id.$oid === id)
    if (index < 0) return undefined
    const replacement: WireDoc = { ...structuredClone(fields), _id: { $oid: id } }
    docs[index] = replacement
    return replacement
  }

  async remove(c: CollectionName, id: string): Promise<WireDoc | undefined> {
    const docs = this.collections[c]
    const index = docs.findIndex((doc) => doc._id.$oid === id)
    if (index < 0) return undefined
    const [removed] = docs.splice(index, 1)
    return removed
  }

  async usersByEmail(email: string): Promise<WireDoc[]> {
    return this.collections.users.filter((u) => u.email === email)
  }

  async reset(): Promise<void> {
    this.reseed()
  }
}

/** The live document (not a copy), for tests that edit a seeded document in place. */
export function findById(store: MemoryStore, c: CollectionName, id: string): WireDoc | undefined {
  return store.collections[c].find((doc) => doc._id.$oid === id)
}
