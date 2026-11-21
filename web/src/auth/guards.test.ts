import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordRequests, resetClientState, signIn } from '../test/renderRoute.tsx'
import { getCurrentUser, isAuthenticated, login, requestCurrentUser } from './currentUser.ts'
import { requireAdminUser, requireAuthenticatedUser } from './guards.ts'
import { closeLoginDialog, getLoginDialogId } from './loginDialog.ts'
import { RetryCancelledError, retryQueue } from './retryQueue.ts'

beforeEach(() => resetClientState())

/** Lets the guard's awaits run, then reports whether its promise has settled. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return done
}

// Legacy common/security/authorization.spec.js
describe('legacy securityAuthorization cases', () => {
  it('requireAuthenticatedUser: makes a GET request to current-user url', async () => {
    await signIn('po')
    const seen = recordRequests()
    expect(isAuthenticated()).toBe(false)
    await requireAuthenticatedUser()
    expect(isAuthenticated()).toBe(true)
    expect(getCurrentUser()?.email).toBe('po@ascrum.test')
    expect(seen.map((r) => [r.method, r.pathname])).toEqual([['GET', '/current-user']])
  })

  it('requireAuthenticatedUser: adds a new item to the retry queue if not authenticated', async () => {
    expect(retryQueue.hasMore()).toBe(false)
    const guard = requireAuthenticatedUser()
    expect(await settled(guard)).toBe(false)
    expect(isAuthenticated()).toBe(false)
    expect(retryQueue.hasMore()).toBe(true)
    expect(retryQueue.retryReason()).toBe('unauthenticated-client')
  })

  it('requireAdminUser: returns a resolved promise if we are already an admin', async () => {
    await signIn('admin')
    await requestCurrentUser()
    const before = getCurrentUser()
    await requireAdminUser()
    expect(getCurrentUser()).toBe(before)
  })

  it('requireAdminUser: adds a new item to the retry queue if not admin', async () => {
    await signIn('po')
    const guard = requireAdminUser()
    expect(await settled(guard)).toBe(false)
    expect(retryQueue.hasMore()).toBe(true)
    expect(retryQueue.retryReason()).toBe('unauthorized-client')
  })
})

describe('guards', () => {
  it('AC-AUTH-06: a guard that is satisfied continues; otherwise it waits, and completes after a login without a reload', async () => {
    const guard = requireAuthenticatedUser()
    await waitFor(() => expect(getLoginDialogId()).not.toBeNull())
    expect(await settled(guard)).toBe(false)

    await login('dev2@ascrum.test', 'demo')
    await expect(guard).resolves.toBeUndefined()
    expect(retryQueue.hasMore()).toBe(false)
  })

  it('AC-AUTH-06: a non-admin login re-queues the admin guard ("not authorized"); cancelling rejects it', async () => {
    const guard = requireAdminUser()
    await waitFor(() => expect(retryQueue.retryReason()).toBe('unauthorized-client'))
    await login('po@ascrum.test', 'demo') // retries the guard, which is still not satisfied
    await waitFor(() => expect(retryQueue.hasMore()).toBe(true))
    expect(getLoginDialogId()).not.toBeNull() // reopened by the new push

    closeLoginDialog(false)
    await expect(guard).rejects.toBeInstanceOf(RetryCancelledError)
  })
})
