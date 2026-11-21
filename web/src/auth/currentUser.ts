// The current user, from legacy security.js (currentUser, requestCurrentUser, login, logout).
// A module store so that loaders (outside React) and components read the same value.
// The `{user: …}` envelope and the 200 `{user:null}` login failure (D19) stay inside this file.
import { request } from '../api/http.ts'
import type { CurrentUser } from '../api/types.ts'
import { closeLoginDialog } from './loginDialog.ts'

let currentUser: CurrentUser | null = null
let inFlight: Promise<CurrentUser | null> | null = null
const listeners = new Set<() => void>()

function setCurrentUser(user: CurrentUser | null): void {
  currentUser = user
  for (const listener of listeners) listener()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{user: {...}}` → CurrentUser; `{user: null}` (or anything unexpected) → null. */
function parseUserEnvelope(body: unknown): CurrentUser | null {
  const user = isRecord(body) ? body.user : undefined
  if (!isRecord(user) || typeof user.id !== 'string') return null
  return {
    id: user.id,
    email: String(user.email ?? ''),
    firstName: String(user.firstName ?? ''),
    lastName: String(user.lastName ?? ''),
    admin: user.admin === true,
  }
}

export function subscribeCurrentUser(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCurrentUser(): CurrentUser | null {
  return currentUser
}

export function isAuthenticated(): boolean {
  return currentUser !== null
}

export function isAdmin(): boolean {
  return currentUser?.admin === true
}

/**
 * AC-AUTH-01: returns the cached user without a request once authenticated; otherwise GETs
 * `/current-user` (legacy re-asked on every call while anonymous). S11: concurrent calls share one
 * in-flight request, so the start-up request and the first guard no longer race.
 */
export function requestCurrentUser(): Promise<CurrentUser | null> {
  if (currentUser !== null) return Promise.resolve(currentUser)
  inFlight ??= request('GET', '/current-user')
    .then((body) => {
      setCurrentUser(parseUserEnvelope(body))
      return currentUser
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * POSTs `/login`. Resolves true when authenticated, false on bad credentials (200 `{user:null}`, D19).
 * Rejects with ApiError on an HTTP failure. Success closes the dialog, which retries the queue.
 */
export async function login(email: string, password: string): Promise<boolean> {
  const body = await request('POST', '/login', { body: { email, password } })
  setCurrentUser(parseUserEnvelope(body))
  if (isAuthenticated()) closeLoginDialog(true)
  return isAuthenticated()
}

/** POSTs `/logout`, then clears the user. Rejects if the request fails (the user stays, as in legacy). */
export async function logout(): Promise<void> {
  await request('POST', '/logout')
  setCurrentUser(null)
}

/** Test isolation only (src/test/renderRoute.tsx): forget the cached user, as a page reload would. */
export function resetCurrentUser(): void {
  inFlight = null
  setCurrentUser(null)
}
