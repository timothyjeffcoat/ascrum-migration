// Start-up, shared by main.tsx (browser router) and src/test/renderRoute.tsx (memory router), so the
// tests exercise the same order of events as the real app.
import { StrictMode, type ReactElement } from 'react'
import type { DataRouter, RouteObject } from 'react-router'
import { requestCurrentUser } from '../auth/currentUser.ts'
import { rotateNotificationsOn } from '../notifications/rotation.ts'
import { AppRoot } from './AppRoot.tsx'
import { buildRoutes } from './router.tsx'

export type BootedApp = { router: DataRouter; app: ReactElement }

export function bootApp(createRouter: (routes: RouteObject[]) => DataRouter, routes = buildRoutes()): BootedApp {
  // 1. Legacy app.run: ask for the current user at start-up, in case of a session from an earlier
  //    visit (AC-AUTH-01). Guards share this request (S11). A failure here is not an error: the
  //    user is simply anonymous, and the next guard asks again.
  requestCurrentUser().catch(() => undefined)
  // 2. Creating the router starts the first navigation's loaders straight away.
  const router = createRouter(routes)
  // 3. Rotation subscribes before React renders anything (spec §4.1, AC-NOT-01).
  rotateNotificationsOn(router)
  return {
    router,
    app: (
      <StrictMode>
        <AppRoot router={router} />
      </StrictMode>
    ),
  }
}
