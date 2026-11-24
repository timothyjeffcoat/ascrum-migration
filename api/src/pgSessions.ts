// PgSessions: the Sessions interface (web/stub/session.ts) on the `sessions` table, so a session
// outlives the process that created it and works across several API containers (spec §3.1, AC-PG-06).
//
// DEV-p5-store-03 (p5-security): a session idle for longer than the lifetime is gone. get() reads and
// marks the session used in one statement, and only while it is still live; sweep() deletes the rest
// (main.ts runs it on a timer). Times come from the injected clock, not now(), so tests can move them.
import pg from 'pg'
import {
  DEFAULT_SESSION_IDLE_SECONDS,
  type Clock,
  type Session,
  type SessionOptions,
  type Sessions,
} from '../../web/stub/session.ts'

export class PgSessions implements Sessions {
  readonly pool: pg.Pool
  readonly idleMs: number
  readonly clock: Clock

  constructor(pool: pg.Pool, opts: SessionOptions = {}) {
    this.pool = pool
    this.idleMs = (opts.idleSeconds ?? DEFAULT_SESSION_IDLE_SECONDS) * 1000
    this.clock = opts.clock ?? Date.now
  }

  async get(sid: string): Promise<Session | undefined> {
    const now = this.clock()
    const { rows } = await this.pool.query<{ xsrf: string; user_id: string | null }>(
      'UPDATE sessions SET last_seen_at = $2 WHERE sid = $1 AND last_seen_at >= $3 RETURNING xsrf, user_id',
      [sid, new Date(now), new Date(now - this.idleMs)],
    )
    const row = rows[0]
    if (!row) return undefined
    return row.user_id === null ? { xsrf: row.xsrf } : { xsrf: row.xsrf, userId: row.user_id }
  }

  async create(): Promise<{ sid: string; session: Session }> {
    const sid = crypto.randomUUID()
    const session: Session = { xsrf: crypto.randomUUID() }
    await this.pool.query('INSERT INTO sessions (sid, xsrf, last_seen_at) VALUES ($1, $2, $3)', [
      sid,
      session.xsrf,
      new Date(this.clock()),
    ])
    return { sid, session }
  }

  async setUser(sid: string, userId: string | undefined): Promise<void> {
    await this.pool.query('UPDATE sessions SET user_id = $2 WHERE sid = $1', [sid, userId ?? null])
  }

  async rotate(sid: string): Promise<string> {
    const next = crypto.randomUUID()
    await this.pool.query('UPDATE sessions SET sid = $2, last_seen_at = $3 WHERE sid = $1', [
      sid,
      next,
      new Date(this.clock()),
    ])
    return next
  }

  async sweep(): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE last_seen_at < $1', [
      new Date(this.clock() - this.idleMs),
    ])
    return rowCount ?? 0
  }

  async clear(): Promise<void> {
    await this.pool.query('TRUNCATE sessions')
  }
}
