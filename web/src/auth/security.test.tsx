// Legacy common/security/security.spec.js (the `security` service is now currentUser.ts, loginDialog.ts
// and AuthProvider), plus AC-AUTH-01 and AC-AUTH-07.
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRequests, renderRoute, resetClientState, signIn, waitForShell } from '../test/renderRoute.tsx'
import { USER } from '../../stub/seed.ts'
import { getCurrentUser, isAdmin, isAuthenticated, login, logout, requestCurrentUser } from './currentUser.ts'
import { requireAuthenticatedUser } from './guards.ts'
import { openLoginDialog } from './loginDialog.ts'
import { retryQueue } from './retryQueue.ts'

beforeEach(() => resetClientState())

describe('legacy security service cases', () => {
  describe('showLogin', () => {
    it('should open the dialog', async () => {
      const { router } = await renderRoute('/projectsinfo')
      await waitFor(() => expect(router.state.initialized).toBe(true))
      expect(document.querySelector('.login-form')).toBeNull()
      act(() => openLoginDialog())
      expect(document.querySelector('.login-form')).toBeInTheDocument()
    })
  })

  describe('login', () => {
    it('sends a http request to login the specified user', async () => {
      await requestCurrentUser() // XSRF cookie
      const seen = recordRequests()
      await login('po@ascrum.test', 'demo')
      expect(seen.map((r) => [r.method, r.pathname, r.body])).toEqual([
        ['POST', '/login', { email: 'po@ascrum.test', password: 'demo' }],
      ])
      expect(getCurrentUser()).toEqual({
        id: USER.po,
        email: 'po@ascrum.test',
        firstName: 'Paula',
        lastName: 'Owner',
        admin: false,
      })
    })

    it('calls queue.retry on a successful login', async () => {
      await requestCurrentUser()
      const retryAll = vi.spyOn(retryQueue, 'retryAll')
      openLoginDialog()
      await login('po@ascrum.test', 'demo')
      expect(retryAll).toHaveBeenCalled()
      expect(getCurrentUser()?.id).toBe(USER.po)
    })

    it('does not call queue.retryAll after a login failure', async () => {
      await requestCurrentUser()
      const retryAll = vi.spyOn(retryQueue, 'retryAll')
      openLoginDialog()
      await login('po@ascrum.test', 'wrong')
      expect(retryAll).not.toHaveBeenCalled()
    })

    it('returns true to success handlers if the user authenticated', async () => {
      await requestCurrentUser()
      await expect(login('po@ascrum.test', 'demo')).resolves.toBe(true)
    })

    it('returns false to success handlers if the user was not authenticated', async () => {
      await requestCurrentUser()
      await expect(login('po@ascrum.test', 'wrong')).resolves.toBe(false)
    })
  })

  describe('logout', () => {
    it('sends a http post to clear the current logged in user', async () => {
      await requestCurrentUser()
      await login('po@ascrum.test', 'demo')
      const seen = recordRequests()
      await logout()
      expect(seen.map((r) => [r.method, r.pathname])).toEqual([['POST', '/logout']])
      expect(getCurrentUser()).toBeNull()
    })

    it('AC-AUTH-07 (legacy: redirects to / by default): Log out POSTs /logout, clears the user and navigates to /', async () => {
      const { router, user } = await renderRoute('/projects', { as: 'po' })
      // The header must be the real shell's, not the first-load copy (DEV-foundation-06).
      await waitForShell(router)
      expect(router.state.location.pathname).toBe('/projects')
      const logoutButton = await screen.findByRole('button', { name: 'Log out' })
      const seen = recordRequests()

      await user.click(logoutButton)

      // One step at a time, so an intermittent CI failure names the step that stalled (DEV-foundation-06):
      // the click reached the stub, then the user was cleared, then '/' and the legacy `otherwise`
      // redirect to /projectsinfo.
      await waitFor(() => expect(seen[0]).toMatchObject({ method: 'POST', pathname: '/logout' }))
      await waitFor(() => expect(getCurrentUser()).toBeNull())
      await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo'))
      expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
    })
  })

  describe('currentUser', () => {
    it('should be unauthenticated to begin with', () => {
      expect(isAuthenticated()).toBe(false)
      expect(isAdmin()).toBe(false)
      expect(getCurrentUser()).toBeNull()
    })

    it('should be authenticated if we update with user info', async () => {
      await requestCurrentUser()
      await login('dev1@ascrum.test', 'demo')
      expect(isAuthenticated()).toBe(true)
      expect(isAdmin()).toBe(false)
    })

    it('should be admin if we update with admin user info', async () => {
      await requestCurrentUser()
      await login('admin@abc.com', 'changeme')
      expect(isAuthenticated()).toBe(true)
      expect(isAdmin()).toBe(true)
    })

    it('should not be authenticated or admin if we clear the user', async () => {
      await requestCurrentUser()
      await login('admin@abc.com', 'changeme')
      expect(isAdmin()).toBe(true)
      await logout()
      expect(isAuthenticated()).toBe(false)
      expect(isAdmin()).toBe(false)
      expect(getCurrentUser()).toBeNull()
    })
  })

  describe('requestCurrentUser', () => {
    it('makes a GET request to current-user url', async () => {
      await signIn('sm')
      const seen = recordRequests()
      expect(isAuthenticated()).toBe(false)
      const user = await requestCurrentUser()
      expect(isAuthenticated()).toBe(true)
      expect(user).toBe(getCurrentUser())
      expect(seen.map((r) => [r.method, r.pathname])).toEqual([['GET', '/current-user']])
    })

    it('returns the current user immediately if they are already authenticated', async () => {
      await signIn('sm')
      const first = await requestCurrentUser()
      const seen = recordRequests()
      await expect(requestCurrentUser()).resolves.toBe(first)
      expect(seen).toEqual([])
    })
  })
})

describe('current user', () => {
  it('AC-AUTH-01: /current-user is requested on start; concurrent requests share one in-flight promise (S11); while anonymous each guard asks again', async () => {
    const seen = recordRequests()
    // Start-up request + the guard of the initial /projects loader: one request between them (S11).
    const { router } = await renderRoute('/projects')
    await screen.findByRole('heading', { name: 'Sign in' })
    const currentUserGets = () => seen.filter((r) => r.pathname === '/current-user').length
    expect(currentUserGets()).toBe(1)
    expect(router.state.initialized).toBe(false)

    // Still anonymous: the next guard asks again (legacy), and concurrent callers share that request.
    const [a, b] = [requestCurrentUser(), requestCurrentUser()]
    expect(a).toBe(b)
    await a
    void requireAuthenticatedUser().catch(() => undefined)
    await waitFor(() => expect(currentUserGets()).toBe(3))
  })

  it('AC-AUTH-01: once authenticated the cached user is returned without a request', async () => {
    const seen = recordRequests()
    await renderRoute('/dashboard', { as: 'po' })
    await screen.findByRole('button', { name: 'Log out' })
    const before = seen.filter((r) => r.pathname === '/current-user').length
    await requireAuthenticatedUser()
    await requestCurrentUser()
    expect(seen.filter((r) => r.pathname === '/current-user').length).toBe(before)
  })
})
