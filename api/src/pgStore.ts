// PgStore: the Store interface (web/stub/store.ts) on PostgreSQL (spec §3.1/§3.2). It must be
// indistinguishable from MemoryStore through handle(); stub/contractTests.ts checks that it is.
//
// SQL safety (AC-PG-05): every value, including field names from `q`, is a bind parameter. The only
// text spliced into SQL is table and column names from the constant map in schema.ts.
//
// Passwords (S-p5-1, AC-SEC-01): a users write stores the scrypt hash of `password` in password_hash
// (passwords.ts) and never the text; reads never return the hash (schema.ts `secret`); login compares
// in findLogin(). The in-memory store keeps plain text on purpose (store.ts explains why).
import pg from 'pg'
import type { Condition, Query } from '../../web/stub/query.ts'
import { seedCollections } from '../../web/stub/seed.ts'
import {
  COLLECTIONS,
  idFromCounter,
  UnstorableValueError,
  type CollectionName,
  type Fields,
  type Store,
  type WireDoc,
} from '../../web/stub/store.ts'
import { hashPassword, PRODUCTION_SCRYPT, verifyPassword, type ScryptParams } from './passwords.ts'
import {
  columnsOf,
  fits,
  isHexId,
  listOf,
  readableColumnsOf,
  TABLES,
  toDoc,
  toRow,
  type StoredRow,
  type Table,
} from './schema.ts'

type Db = pg.Pool | pg.PoolClient

export type PgStoreOptions = {
  /** Hash cost. Production uses PRODUCTION_SCRYPT; the contract tests a cheap one (testDb.ts). */
  scrypt?: ScryptParams
}

export class PgStore implements Store {
  readonly pool: pg.Pool
  readonly scrypt: ScryptParams
  /** Seed passwords hashed once per process, so a reset (dev and CI only) does not pay scrypt again. */
  private readonly seedHashes = new Map<string, Promise<string>>()
  private decoy: Promise<string> | undefined

  constructor(pool: pg.Pool, options: PgStoreOptions = {}) {
    this.pool = pool
    this.scrypt = options.scrypt ?? PRODUCTION_SCRYPT
  }

  async list(c: CollectionName, query: Query): Promise<WireDoc[]> {
    return select(this.pool, TABLES[c], query)
  }

  async get(c: CollectionName, id: string): Promise<WireDoc | undefined> {
    return getById(this.pool, TABLES[c], id)
  }

  async insert(c: CollectionName, fields: Fields): Promise<WireDoc> {
    // Checked before the counter moves, so a refused write leaves the next id unchanged (AC-STUB-15).
    assertStorable(fields)
    const stored = c === 'users' ? await this.hashed(fields) : fields
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ n: string }>("SELECT nextval('wire_id_counter') AS n")
      const id = idFromCounter(Number(rows[0]?.n))
      await insertRow(client, TABLES[c], id, stored)
      return mustGet(client, TABLES[c], id)
    })
  }

  async replace(c: CollectionName, id: string, fields: Fields): Promise<WireDoc | undefined> {
    if (!isHexId(id)) return undefined
    assertStorable(fields)
    const t = TABLES[c]
    // S8: a users PUT without `password` keeps the stored hash (the column is left out of the SET).
    const keepPassword = c === 'users' && !Object.hasOwn(fields, 'password')
    const stored = c === 'users' ? await this.hashed(fields) : fields
    return this.transaction(async (client) => {
      const row = toRow(t, stored)
      const list = listOf(t)
      const sets: string[] = []
      const params: unknown[] = [id]
      columnsOf(t).forEach((f, i) => {
        if (keepPassword && f.secret) return
        params.push(row.columns[i])
        sets.push(`${f.column} = $${params.length}`)
      })
      if (list) {
        params.push(row.list.present)
        sets.push(`${list.flag} = $${params.length}`)
      }
      params.push(JSON.stringify(row.extra))
      sets.push(`extra = $${params.length}::jsonb`)
      // An UPDATE keeps `seq`, so the document keeps its place in lists, as the memory array did.
      const updated = await client.query(`UPDATE ${t.table} SET ${sets.join(', ')} WHERE id = $1`, params)
      if (updated.rowCount === 0) return undefined
      if (list) {
        await client.query(`DELETE FROM ${list.table} WHERE ${list.owner} = $1`, [id])
        await insertItems(client, t, id, row.list.items)
      }
      return mustGet(client, t, id)
    })
  }

  async remove(c: CollectionName, id: string): Promise<WireDoc | undefined> {
    if (!isHexId(id)) return undefined
    const t = TABLES[c]
    return this.transaction(async (client) => {
      const doc = await getById(client, t, id, 'FOR UPDATE')
      if (!doc) return undefined
      await client.query(`DELETE FROM ${t.table} WHERE id = $1`, [id]) // join rows go by ON DELETE CASCADE
      return doc
    })
  }

  async findLogin(email: string, password: string): Promise<WireDoc | undefined> {
    // DEV-p5-store-10: the e-mail is a bind parameter, never part of the SQL text (security.test.ts
    // records every statement a sign-in sends and checks exactly that).
    const { rows } = await this.pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1 ORDER BY seq',
      [email],
    )
    let checked = 0
    for (const row of rows) {
      if (row.password_hash === null) continue
      checked += 1
      if (await verifyPassword(password, row.password_hash)) return getById(this.pool, TABLES.users, row.id)
    }
    // An unknown e-mail would otherwise answer at once, while a known one costs a scrypt run: the
    // response time would tell which e-mails have accounts. Pay for one hash either way.
    if (checked === 0) await verifyPassword(password, await this.decoyHash())
    return undefined
  }

  /**
   * Rows written before migration 002 hold a plain-text password in `users.password`. Hashes them into
   * password_hash and empties the old column; returns how many. main.ts runs it on every start (a no-op
   * once done), because SQL cannot compute scrypt.
   */
  async hashPlainPasswords(): Promise<number> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string; password: string }>(
        'SELECT id, password FROM users WHERE password IS NOT NULL FOR UPDATE',
      )
      for (const row of rows) {
        const hash = await hashPassword(row.password, this.scrypt)
        await client.query('UPDATE users SET password_hash = $2, password = NULL WHERE id = $1', [row.id, hash])
      }
      return rows.length
    })
  }

  /** `fields` with `password` replaced by its hash; a non-string password (it can never sign in) is dropped. */
  private async hashed(fields: Fields, seedId?: string): Promise<Fields> {
    if (!Object.hasOwn(fields, 'password')) return fields
    const { password, ...rest } = fields
    if (typeof password !== 'string') return rest
    if (seedId === undefined) return { ...rest, password: await hashPassword(password, this.scrypt) }
    const key = `${seedId}:${password}`
    let hash = this.seedHashes.get(key)
    if (!hash) {
      hash = hashPassword(password, this.scrypt) // each seed user still gets a salt of its own
      this.seedHashes.set(key, hash)
    }
    return { ...rest, password: await hash }
  }

  private decoyHash(): Promise<string> {
    this.decoy ??= hashPassword(crypto.randomUUID(), this.scrypt)
    return this.decoy
  }

  async reset(): Promise<void> {
    await this.transaction(async (client) => {
      const tables = COLLECTIONS.flatMap((c) => {
        const list = listOf(TABLES[c])
        return list ? [TABLES[c].table, list.table] : [TABLES[c].table]
      })
      await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`)
      await client.query('ALTER SEQUENCE wire_id_counter RESTART WITH 1')
      const seed = seedCollections()
      for (const c of COLLECTIONS) {
        for (const doc of seed[c]) {
          const fields = c === 'users' ? await this.hashed(doc, doc._id.$oid) : doc
          await insertRow(client, TABLES[c], doc._id.$oid, fields)
        }
      }
    })
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

async function insertRow(client: pg.PoolClient, t: Table, id: string, fields: Fields): Promise<void> {
  const row = toRow(t, fields)
  const names = ['id', ...columnsOf(t).map((f) => f.column)]
  const params: unknown[] = [id, ...row.columns]
  const list = listOf(t)
  if (list) {
    names.push(list.flag)
    params.push(row.list.present)
  }
  names.push('extra')
  params.push(JSON.stringify(row.extra))
  const placeholders = params.map((_, i) => (i === params.length - 1 ? `$${i + 1}::jsonb` : `$${i + 1}`))
  await client.query(`INSERT INTO ${t.table} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`, params)
  await insertItems(client, t, id, row.list.items)
}

async function insertItems(client: pg.PoolClient, t: Table, id: string, items: string[]): Promise<void> {
  const list = listOf(t)
  if (!list || items.length === 0) return
  await client.query(
    `INSERT INTO ${list.table} (${list.owner}, position, ${list.item})
     SELECT $1, ord - 1, item FROM unnest($2::text[]) WITH ORDINALITY AS u(item, ord)`,
    [id, items],
  )
}

async function getById(db: Db, t: Table, id: string, lock = ''): Promise<WireDoc | undefined> {
  if (!isHexId(id)) return undefined // not an id this store can hold; also keeps char(24) from truncating
  const [doc] = await select(db, t, [{ kind: 'idIn', ids: [id] }], lock)
  return doc
}

async function mustGet(db: Db, t: Table, id: string): Promise<WireDoc> {
  const doc = await getById(db, t, id)
  if (!doc) throw new Error(`${t.table} ${id} vanished inside its own transaction`)
  return doc
}

async function select(db: Db, t: Table, query: Query, lock = ''): Promise<WireDoc[]> {
  const params: unknown[] = []
  const conditions = query.map((condition) => sqlCondition(t, condition, params))
  const list = listOf(t)
  const columns = [
    't.id',
    ...readableColumnsOf(t).map((f) => `t.${f.column}`),
    ...(list ? [`t.${list.flag}`] : []),
    't.extra',
  ]
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await db.query<StoredRow>(
    `SELECT ${columns.join(', ')} FROM ${t.table} t ${where} ORDER BY t.seq ${lock}`,
    params,
  )
  const items = new Map<string, string[]>()
  if (list && rows.length > 0) {
    const listed = await db.query<{ owner: string; item: string }>(
      `SELECT ${list.owner} AS owner, ${list.item} AS item FROM ${list.table}
       WHERE ${list.owner} = ANY($1::char(24)[]) ORDER BY ${list.owner}, position`,
      [rows.map((r) => r.id)],
    )
    for (const { owner, item } of listed.rows) items.set(owner, [...(items.get(owner) ?? []), item])
  }
  return rows.map((row) => toDoc(t, row, items.get(row.id) ?? []))
}

/**
 * One `q` condition as SQL, with the same meaning as `matches()` in web/stub/query.ts (strict `===`).
 * A value lives in its column only if it fits the column (schema.ts), so a value that would not fit
 * can only be in `extra`, and is looked for there.
 */
function sqlCondition(t: Table, condition: Condition, params: unknown[]): string {
  const param = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }
  if (condition.kind === 'idIn') {
    // Only 24-hex strings can be stored ids; anything else matches nothing, as in the memory store.
    return `t.id = ANY(${param(condition.ids.filter(isHexId))}::char(24)[])`
  }
  const column = columnsOf(t).find((f) => f.wire === condition.field)
  if (column && fits(column.kind, condition.value)) return `t.${column.column} = ${param(condition.value)}`
  return `t.extra -> ${param(condition.field)} = ${param(JSON.stringify(condition.value))}::jsonb`
}

/**
 * DEV-p5-store-04: PostgreSQL text and jsonb cannot hold a NUL character, and the UTF-8 encoding
 * silently replaces a lone surrogate. The in-memory store kept both. Refuse (handle() answers 400)
 * rather than store something other than what was sent.
 */
// A UTF-16 surrogate that is not part of a pair (with the u flag, a valid pair is one code point).
const LONE_SURROGATE = /\p{Cs}/u

export function assertStorable(value: unknown, path = 'body'): void {
  if (typeof value === 'string') {
    if (value.includes('\u0000') || LONE_SURROGATE.test(value)) {
      throw new UnstorableValueError(`${path} contains a character the database cannot store`)
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertStorable(item, `${path}[${i}]`))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      assertStorable(key, `${path} key`)
      assertStorable(item, `${path}.${key}`)
    }
  }
}
