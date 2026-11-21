// Server-side sessions keyed by the `sid` cookie (stands in for Express cookieSession + Passport).
export type Session = { userId?: string; xsrf: string }
export type Sessions = Map<string, Session>

export const SESSION_COOKIE = 'sid'
export const XSRF_COOKIE = 'XSRF-TOKEN'
export const XSRF_HEADER = 'x-xsrf-token'

export function createSessions(): Sessions {
  return new Map()
}

/** Returns the caller's session, creating one (with a fresh XSRF token) for an unknown or missing sid. */
export function getOrCreateSession(
  sessions: Sessions,
  sid: string | undefined,
): { sid: string; session: Session; created: boolean } {
  const existing = sid ? sessions.get(sid) : undefined
  if (sid && existing) return { sid, session: existing, created: false }
  const fresh = crypto.randomUUID()
  const session: Session = { xsrf: crypto.randomUUID() }
  sessions.set(fresh, session)
  return { sid: fresh, session, created: true }
}
