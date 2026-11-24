// Server-side sessions keyed by the `sid` cookie (stands in for Express cookieSession + Passport).
// Phase 5 (spec §3.1): an interface with two implementations, MemorySessions (here) and PgSessions
// (api/src/pgSessions.ts, a `sessions` table, so sessions survive a restart: AC-PG-06).
export type Session = { userId?: string; xsrf: string }

export interface Sessions {
  get(sid: string): Promise<Session | undefined>
  /** A new session with a fresh XSRF token and no user. */
  create(): Promise<{ sid: string; session: Session }>
  /** Sets (login) or clears (logout, `undefined`) the session's user. */
  setUser(sid: string, userId: string | undefined): Promise<void>
  /** Drops every session (reset, AC-STUB-14). */
  clear(): Promise<void>
}

export const SESSION_COOKIE = 'sid'
export const XSRF_COOKIE = 'XSRF-TOKEN'
export const XSRF_HEADER = 'x-xsrf-token'

export class MemorySessions implements Sessions {
  readonly map = new Map<string, Session>()

  async get(sid: string): Promise<Session | undefined> {
    const session = this.map.get(sid)
    return session && { ...session }
  }

  async create(): Promise<{ sid: string; session: Session }> {
    const sid = crypto.randomUUID()
    const session: Session = { xsrf: crypto.randomUUID() }
    this.map.set(sid, session)
    return { sid, session: { ...session } }
  }

  async setUser(sid: string, userId: string | undefined): Promise<void> {
    const session = this.map.get(sid)
    if (!session) return
    if (userId === undefined) delete session.userId
    else session.userId = userId
  }

  async clear(): Promise<void> {
    this.map.clear()
  }
}

/** Returns the caller's session, creating one (with a fresh XSRF token) for an unknown or missing sid. */
export async function getOrCreateSession(
  sessions: Sessions,
  sid: string | undefined,
): Promise<{ sid: string; session: Session; created: boolean }> {
  const existing = sid ? await sessions.get(sid) : undefined
  if (sid && existing) return { sid, session: existing, created: false }
  return { ...(await sessions.create()), created: true }
}
