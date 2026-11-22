// The spec §4.1 composition. The providers sit OUTSIDE RouterProvider: a data router renders nothing
// of its routes until the first navigation's loaders finish, so a guard in an initial loader (a deep
// link reloaded while logged out) must be able to open the login dialog from out here, or the app
// would wait forever (risk §11-4).
// RouterProvider comes from 'react-router', not 'react-router/dom': under Vitest the two entry points
// resolve to different module copies, and hooks then can't see the router context.
import { RouterProvider, type DataRouter } from 'react-router'
import { AuthProvider } from '../auth/AuthProvider.tsx'
import { LoginModal } from '../auth/LoginModal.tsx'
import { RootErrorBoundary } from './RootErrorBoundary.tsx'

type AppRootProps = { router: DataRouter }

export function AppRoot({ router }: AppRootProps) {
  return (
    <RootErrorBoundary>
      <AuthProvider router={router}>
        <LoginModal />
        <RouterProvider router={router} />
      </AuthProvider>
    </RootErrorBoundary>
  )
}
