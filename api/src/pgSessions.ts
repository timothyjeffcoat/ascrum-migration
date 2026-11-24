// PgSessions: the Sessions interface (web/stub/session.ts) on the `sessions` table, so a session
// outlives the process that created it and works across several API containers (spec §3.1, AC-PG-06).
import pg from 'pg'
import type { Session, Sessions } from '../../web/stub/session.ts'

export class PgSessions implements Sessions {
  readonly pool: pg.Pool
  constructor(pool: pg.Pool) {
    this.pool = pool
  }

  async get(sid: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<{ xsrf: string; user_id: string | null }>(
      'SELECT xsrf, user_id FROM sessions WHERE sid = $1',
      [sid],
    )
    const row = rows[0]
    if (!row) return undefined
    return row.user_id === null ? { xsrf: row.xsrf } : { xsrf: row.xsrf, userId: row.user_id }
  }

  async create(): Promise<{ sid: string; session: Session }> {
    const sid = crypto.randomUUID()
    const session: Session = { xsrf: crypto.randomUUID() }
    await this.pool.query('INSERT INTO sessions (sid, xsrf) VALUES ($1, $2)', [sid, session.xsrf])
    return { sid, session }
  }

  async setUser(sid: string, userId: string | undefined): Promise<void> {
    await this.pool.query('UPDATE sessions SET user_id = $2 WHERE sid = $1', [sid, userId ?? null])
  }

  async clear(): Promise<void> {
    await this.pool.query('TRUNCATE sessions')
  }
}
