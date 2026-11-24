// PgLoginThrottle: the LoginThrottle interface (web/stub/throttle.ts, which states the rule) on the
// `login_throttle` table (migration 002), so every API container counts the same failures and a restart
// does not wipe them. Times come from the injected clock, like PgSessions.
import pg from 'pg'
import type { Clock } from '../../web/stub/session.ts'
import { throttleKeys, type LoginAttempt, type LoginThrottle, type ThrottleLimits } from '../../web/stub/throttle.ts'

export class PgLoginThrottle implements LoginThrottle {
  readonly pool: pg.Pool
  readonly limits: ThrottleLimits
  readonly clock: Clock

  constructor(pool: pg.Pool, limits: ThrottleLimits, clock: Clock = Date.now) {
    this.pool = pool
    this.limits = limits
    this.clock = clock
  }

  private get windowMs(): number {
    return this.limits.windowSeconds * 1000
  }

  async retryAfter(attempt: LoginAttempt): Promise<number> {
    const keys = throttleKeys(attempt, this.limits)
    if (keys.length === 0) return 0
    const now = this.clock()
    const { rows } = await this.pool.query<{ key: string; window_start: Date; failures: number }>(
      'SELECT key, window_start, failures FROM login_throttle WHERE key = ANY($1::text[]) AND window_start > $2',
      [keys.map((k) => k.key), new Date(now - this.windowMs)],
    )
    let wait = 0
    for (const row of rows) {
      const max = keys.find((k) => k.key === row.key)?.max ?? Infinity
      if (row.failures >= max) {
        wait = Math.max(wait, Math.ceil((row.window_start.getTime() + this.windowMs - now) / 1000))
      }
    }
    return wait
  }

  async recordFailure(attempt: LoginAttempt): Promise<void> {
    const now = new Date(this.clock())
    const expired = new Date(now.getTime() - this.windowMs)
    for (const { key } of throttleKeys(attempt, this.limits)) {
      // One statement per key, so two containers counting at once both count (no read-modify-write).
      await this.pool.query(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN login_throttle.window_start <= $3 THEN 1 ELSE login_throttle.failures + 1 END,
           window_start = CASE WHEN login_throttle.window_start <= $3 THEN $2 ELSE login_throttle.window_start END`,
        [key, now, expired],
      )
    }
  }

  async recordSuccess(account: string): Promise<void> {
    await this.pool.query('DELETE FROM login_throttle WHERE key = $1', [`account:${account}`])
  }

  async sweep(): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM login_throttle WHERE window_start <= $1', [
      new Date(this.clock() - this.windowMs),
    ])
    return rowCount ?? 0
  }

  async clear(): Promise<void> {
    await this.pool.query('TRUNCATE login_throttle')
  }
}
