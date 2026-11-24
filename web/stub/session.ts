// Server-side sessions keyed by the `sid` cookie (stands in for Express cookieSession + Passport).
// Phase 5 (spec §3.1): an interface with two implementations, MemorySessions (here) and PgSessions
// (api/src/pgSessions.ts, a `sessions` table, so sessions survive a restart: AC-PG-06).
//
// DEV-p5-store-03 (p5-security): sessions expire after an idle lifetime. Every get() of a live session
// counts as activity; a session idle for longer than the lifetime reads as missing, so the caller gets a
// new anonymous session, and sweep() deletes the expired ones. Legacy cookieSession never expired.
export type Session = { userId?: string; xsrf: string }

/** Milliseconds since the epoch. Injected so tests can move time; Date.now otherwise. */
export type Clock = () => number

export type SessionOptions = {
  /** A session unused for longer than this is gone. */
  idleSeconds?: number
  clock?: Clock
}

/** 8 hours, a working day: a user who leaves the app open over lunch is still signed in. */
export const DEFAULT_SESSION_IDLE_SECONDS = 8 * 60 * 60

export interface Sessions {
  /** The live session, which this call marks as used; undefined when unknown or expired. */
  get(sid: string): Promise<Session | undefined>
  /** A new session with a fresh XSRF token and no user. */
  create(): Promise<{ sid: string; session: Session }>
  /** Sets (login) or clears (logout, `undefined`) the session's user. */
  setUser(sid: string, userId: string | undefined): Promise<void>
  /**
   * Moves a session to a new, random sid and returns it; the old sid stops existing. Login does this
   * (session fixation). The XSRF token and the user stay as they were.
   */
  rotate(sid: string): Promise<string>
  /** Deletes every expired session; returns how many. */
  sweep(): Promise<number>
  /** Drops every session (reset, AC-STUB-14). */
  clear(): Promise<void>
}

export const SESSION_COOKIE = 'sid'
export const XSRF_COOKIE = 'XSRF-TOKEN'
export const XSRF_HEADER = 'x-xsrf-token'

type Stored = Session & { lastSeen: number }

export class MemorySessions implements Sessions {
  readonly map = new Map<string, Stored>()
  readonly idleMs: number
  readonly clock: Clock

  constructor(opts: SessionOptions = {}) {
    this.idleMs = (opts.idleSeconds ?? DEFAULT_SESSION_IDLE_SECONDS) * 1000
    this.clock = opts.clock ?? Date.now
  }

  async get(sid: string): Promise<Session | undefined> {
    const stored = this.map.get(sid)
    if (!stored) return undefined
    const now = this.clock()
    if (now - stored.lastSeen > this.idleMs) {
      this.map.delete(sid)
      return undefined
    }
    stored.lastSeen = now
    return stored.userId === undefined ? { xsrf: stored.xsrf } : { xsrf: stored.xsrf, userId: stored.userId }
  }

  async create(): Promise<{ sid: string; session: Session }> {
    const sid = crypto.randomUUID()
    const xsrf = crypto.randomUUID()
    this.map.set(sid, { xsrf, lastSeen: this.clock() })
    return { sid, session: { xsrf } }
  }

  async setUser(sid: string, userId: string | undefined): Promise<void> {
    const session = this.map.get(sid)
    if (!session) return
    if (userId === undefined) delete session.userId
    else session.userId = userId
  }

  async rotate(sid: string): Promise<string> {
    const stored = this.map.get(sid)
    const next = crypto.randomUUID()
    this.map.delete(sid)
    if (stored) this.map.set(next, { ...stored, lastSeen: this.clock() })
    return next
  }

  async sweep(): Promise<number> {
    const now = this.clock()
    let removed = 0
    for (const [sid, stored] of this.map) {
      if (now - stored.lastSeen > this.idleMs) {
        this.map.delete(sid)
        removed += 1
      }
    }
    return removed
  }

  async clear(): Promise<void> {
    this.map.clear()
  }
}

/** Returns the caller's session, creating one (with a fresh XSRF token) for an unknown, expired or missing sid. */
export async function getOrCreateSession(
  sessions: Sessions,
  sid: string | undefined,
): Promise<{ sid: string; session: Session; created: boolean }> {
  const existing = sid ? await sessions.get(sid) : undefined
  if (sid && existing) return { sid, session: existing, created: false }
  return { ...(await sessions.create()), created: true }
}
