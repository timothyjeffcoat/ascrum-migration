// Port of security/authorization.js. Legacy guards were route resolves; here loaders `await` them first
// (spec §4). A guard that isn't satisfied queues itself on the retry queue, which opens the login
// dialog, and waits: after a login it runs again, so the loader completes without a reload
// (AC-AUTH-06). A cancelled login rejects it with RetryCancelledError, which RouteError reports.
import { isAdmin, isAuthenticated, requestCurrentUser } from './currentUser.ts'
import { retryQueue } from './retryQueue.ts'

export async function requireAuthenticatedUser(): Promise<void> {
  await requestCurrentUser()
  if (!isAuthenticated()) await retryQueue.pushRetryFn('unauthenticated-client', requireAuthenticatedUser)
}

export async function requireAdminUser(): Promise<void> {
  await requestCurrentUser()
  if (!isAdmin()) await retryQueue.pushRetryFn('unauthorized-client', requireAdminUser)
}
