// Test databases for `pnpm test:integration`. Each context gets its own PostgreSQL schema (namespace),
// so test files can run in parallel against one server without seeing each other's rows.
//
// No DATABASE_URL means a hard failure, never a skip (spec §3.1, gate rule): importing this module
// throws, so every integration file fails loudly.
import { afterAll } from 'vitest'
import pg from 'pg'
import type { Backend } from '../../web/stub/contractTests.ts'
import type { StubContext } from '../../web/stub/handlers.ts'
import { migrate } from './migrate.ts'
import { PgSessions } from './pgSessions.ts'
import { PgStore } from './pgStore.ts'

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    'pnpm test:integration needs a PostgreSQL database in DATABASE_URL. Locally: `docker compose up -d db` at ' +
      'the repo root, then DATABASE_URL=postgres://ascrum:ascrum@localhost:55436/ascrum (see compose.yaml).',
  )
}
export const DATABASE_URL: string = url

const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
const pools: pg.Pool[] = []
const schemas: string[] = []

/** A pool whose connections all use `schema` (search_path), like a database of its own. */
export function poolFor(schema: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 4 })
  pools.push(pool)
  return pool
}

/** A new, empty schema. Names are generated here, never taken from outside. */
export async function emptySchema(): Promise<string> {
  const schema = `t_${crypto.randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  schemas.push(schema)
  return schema
}

/** A migrated, seeded PgStore and PgSessions in a fresh schema. */
export async function pgContext(opts: { allowReset: boolean }): Promise<StubContext<PgStore, PgSessions>> {
  const pool = poolFor(await emptySchema())
  await migrate(pool)
  const store = new PgStore(pool)
  await store.reset()
  return { store, sessions: new PgSessions(pool), allowReset: opts.allowReset }
}

export const pgBackend: Backend = { name: 'PgStore', createContext: pgContext }

afterAll(async () => {
  await Promise.all(pools.filter((pool) => !pool.ended).map((pool) => pool.end()))
  for (const schema of schemas) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
})
