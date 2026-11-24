// The API (Q-p5-1 (b)): the stub's handle() and Node adapter over PostgreSQL. The wire contract is the
// stub's, unchanged; only the store and the sessions differ.
//
//   DATABASE_URL=postgres://...  PORT=3000  [ALLOW_RESET=1]  node api/src/main.ts
//
// On start it applies pending migrations. A database that has just been created gets the seed
// (spec §3.3, the same seed.ts as the stub); an existing one is left alone, so a restart keeps data
// and sessions (AC-PG-06).
import type { Server } from 'node:http'
import pg from 'pg'
import { startStubServer } from '../../web/stub/server.ts'
import { migrate } from './migrate.ts'
import { PgSessions } from './pgSessions.ts'
import { PgStore } from './pgStore.ts'

export type ApiOptions = {
  pool: pg.Pool
  port: number
  /** POST /__stub/reset exists only with ALLOW_RESET=1: local runs and CI, never production (§3.3). */
  allowReset: boolean
}

export async function startApi({ pool, port, allowReset }: ApiOptions): Promise<Server> {
  const applied = await migrate(pool)
  const store = new PgStore(pool)
  if (applied.includes('001')) await store.reset() // a brand-new database: load the seed once
  return startStubServer(port, { store, sessions: new PgSessions(pool), allowReset })
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const port = Number(process.env.PORT ?? 3000)
  const pool = new pg.Pool({ connectionString: url })
  await startApi({ pool, port, allowReset: process.env.ALLOW_RESET === '1' })
  console.log(`[api] listening on http://localhost:${port}`)
}
