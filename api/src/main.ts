// The API (Q-p5-1 (b)): the stub's handle() and Node adapter over PostgreSQL. The wire contract is the
// stub's, unchanged; only the store and the sessions differ, plus the p5-security additions (spec §3.4):
// hashed passwords, cookie flags, login throttling, session expiry. Configuration: config.ts.
//
//   DATABASE_URL=postgres://...  [APP_ENV=development ALLOW_RESET=1]  node api/src/main.ts
//
// On start it applies pending migrations. A database that has just been created gets the seed
// (spec §3.3, the same seed.ts as the stub); an existing one is left alone, so a restart keeps data
// and sessions (AC-PG-06), apart from hashing any password written before migration 002.
import type { Server } from 'node:http'
import pg from 'pg'
import { startStubServer } from '../../web/stub/server.ts'
import type { Clock } from '../../web/stub/session.ts'
import { DEFAULT_THROTTLE } from '../../web/stub/throttle.ts'
import { DEFAULT_SWEEP_SECONDS, loadConfig, type ApiSettings } from './config.ts'
import { migrate } from './migrate.ts'
import type { ScryptParams } from './passwords.ts'
import { PgSessions } from './pgSessions.ts'
import { PgStore } from './pgStore.ts'
import { PgLoginThrottle } from './pgThrottle.ts'

export type ApiOptions = Partial<ApiSettings> & {
  pool: pg.Pool
  port: number
  /** Tests only: a hand-moved clock for session and throttle times. */
  clock?: Clock
  /** Tests only: a cheaper hash. Production always uses PRODUCTION_SCRYPT. */
  scrypt?: ScryptParams
}

/**
 * Starts the API. Every setting left out takes its production default (config.ts), so the safe choice
 * is the one a caller gets without asking: production mode, no reset route, throttling on.
 */
export async function startApi(options: ApiOptions): Promise<Server> {
  const { pool, port, clock = Date.now } = options
  const applied = await migrate(pool)
  const store = new PgStore(pool, { scrypt: options.scrypt })
  if (applied.includes('001')) {
    await store.reset() // a brand-new database: load the seed once
  } else {
    await store.hashPlainPasswords() // S-p5-1: rows written before migration 002, if any
  }

  const sessions = new PgSessions(pool, { idleSeconds: options.sessionIdleSeconds, clock })
  const loginThrottle = new PgLoginThrottle(pool, options.throttle ?? DEFAULT_THROTTLE, clock)
  const server = await startStubServer(
    port,
    { store, sessions, loginThrottle, allowReset: options.allowReset ?? false },
    { secureCookies: options.production ?? true, trustProxyHops: options.trustProxyHops ?? 0 },
  )

  // DEV-p5-store-03: expired sessions (and ended throttle windows) are deleted on a timer, so rows from
  // cookie-less clients (health checks, crawlers) do not pile up. unref: the timer never keeps the
  // process alive on its own; it stops with the server.
  const sweep = () => {
    Promise.all([sessions.sweep(), loginThrottle.sweep()]).catch((error: unknown) => {
      console.error('[api] sweep failed', error)
    })
  }
  const timer = setInterval(sweep, (options.sweepIntervalSeconds ?? DEFAULT_SWEEP_SECONDS) * 1000).unref()
  server.on('close', () => clearInterval(timer))
  return server
}

if (import.meta.main) {
  const config = loadConfig(process.env)
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  await startApi({ pool, port: config.port, ...config.settings })
  const mode = config.settings.production ? 'production' : 'development'
  console.log(`[api] listening on http://localhost:${config.port} (${mode} mode)`)
}
