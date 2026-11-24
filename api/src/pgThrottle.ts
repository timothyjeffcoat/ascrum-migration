// PgLoginThrottle: the LoginThrottle interface (web/stub/throttle.ts, which states the rule) on the
// `login_throttle` table (migration 002), so every API container counts the same failures and a restart
// does not wipe them. Times come from the injected clock, like PgSessions.
//
// DEV-p5-security-08: admit() reserves with one INSERT … ON CONFLICT DO UPDATE … WHERE per key. PostgreSQL
// locks the conflicting row and evaluates the WHERE on its latest committed version, so two requests (in
// one container or several) can never both take the last place under the limit: the check and the count
// are the same statement. Keys go in throttleKeys() order (address first); if a later key refuses, the
// places already taken are given back.
import pg from 'pg'
import type { Clock } from '../../web/stub/session.ts'
import {
  throttleKeys,
  type Admission,
  type LoginAttempt,
  type LoginThrottle,
  type Reservation,
  type ReservedKey,
  type ThrottleLimits,
} from '../../web/stub/throttle.ts'

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

  async admit(attempt: LoginAttempt): Promise<Admission> {
    const keys = throttleKeys(attempt, this.limits)
    const now = new Date(this.clock())
    const expired = new Date(now.getTime() - this.windowMs)
    const reserved: ReservedKey[] = []
    for (const { key, max } of keys) {
      // Starts a window, or counts one more in the live one if it is under `max`; otherwise changes
      // nothing and returns no row.
      const { rows } = await this.pool.query<{ window_start: Date }>(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN login_throttle.window_start <= $3 THEN 1 ELSE login_throttle.failures + 1 END,
           window_start = CASE WHEN login_throttle.window_start <= $3 THEN $2 ELSE login_throttle.window_start END
         WHERE login_throttle.window_start <= $3 OR login_throttle.failures < $4
         RETURNING window_start`,
        [key, now, expired, max],
      )
      const row = rows[0]
      if (!row) {
        for (const taken of reserved) await this.release(taken)
        return { allowed: false, retryAfter: await this.waitFor(keys, now.getTime()) }
      }
      reserved.push({ key, windowStart: row.window_start.getTime() })
    }
    return { allowed: true, reservation: { attempt, keys: reserved } }
  }

  async succeeded(reservation: Reservation): Promise<void> {
    const { account, ip } = reservation.attempt
    if (account !== undefined)
      await this.pool.query('DELETE FROM login_throttle WHERE key = $1', [`account:${account}`])
    const reservedIp = reservation.keys.find((k) => k.key === `ip:${ip}`)
    if (reservedIp) await this.release(reservedIp)
  }

  /**
   * Gives back one reserved failure, in the window it was taken in only (a newer window never held it).
   * The table keeps failures > 0, so the last one deletes the row. Two statements: if another request
   * counts in between, this one may give back nothing, which leaves the count one too high (fails closed).
   */
  private async release({ key, windowStart }: ReservedKey): Promise<void> {
    const start = new Date(windowStart)
    const { rowCount } = await this.pool.query(
      'UPDATE login_throttle SET failures = failures - 1 WHERE key = $1 AND window_start = $2 AND failures > 1',
      [key, start],
    )
    if (rowCount === 0) {
      await this.pool.query('DELETE FROM login_throttle WHERE key = $1 AND window_start = $2 AND failures = 1', [
        key,
        start,
      ])
    }
  }

  /** Seconds until the latest-ending blocked window among `keys` ends (Retry-After). */
  private async waitFor(keys: { key: string; max: number }[], now: number): Promise<number> {
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
    // The blocking row went away between the two statements (a success or a sweep): try again at once.
    return Math.max(wait, 1)
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
