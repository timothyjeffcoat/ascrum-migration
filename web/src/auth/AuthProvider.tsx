// Replaces the legacy `security` service for components (spec §4.1). It sits OUTSIDE RouterProvider,
// so it navigates through the router object it is given rather than a hook.
import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { DataRouter } from 'react-router'
import { AuthContext, type Auth } from './authContext.ts'
import { getCurrentUser, login, logout, subscribeCurrentUser } from './currentUser.ts'
import { closeLoginDialog, openLoginDialog } from './loginDialog.ts'

type AuthProviderProps = {
  router: Pick<DataRouter, 'navigate'>
  children: ReactNode
}

export function AuthProvider({ router, children }: AuthProviderProps) {
  const currentUser = useSyncExternalStore(subscribeCurrentUser, getCurrentUser)

  const auth = useMemo<Auth>(
    () => ({
      currentUser,
      isAuthenticated: currentUser !== null,
      isAdmin: currentUser?.admin === true,
      showLogin: openLoginDialog,
      login,
      cancelLogin() {
        closeLoginDialog(false)
        void router.navigate('/')
      },
      logout() {
        // §5.9: legacy logout(redirectTo) had a parameter no caller passed; logout always goes to '/'.
        // D19: a failed logout is not surfaced, and the user stays logged in, as in legacy.
        logout().then(
          () => router.navigate('/'),
          () => undefined,
        )
      },
    }),
    [currentUser, router],
  )

  return <AuthContext value={auth}>{children}</AuthContext>
}
