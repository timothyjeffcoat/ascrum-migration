// Renders the whole app at a path, the way main.tsx does (app/bootApp.tsx), with a memory router.
// `as` signs a seeded persona in on the stub first, then forgets the user in the client, so the app
// starts like a page reload with a live session: the start-up `/current-user` request finds it.
//
//   const { user, router } = await renderRoute('/admin/users', { as: 'admin' })
//   expect(await screen.findByRole(...)).toBeVisible()
import { render, type RenderResult } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { createMemoryRouter, type DataRouter, type RouteObject } from 'react-router'
import { onTestFinished } from 'vitest'
import { CREDENTIALS } from '../../stub/seed.ts'
import { bootApp } from '../app/bootApp.tsx'
import { buildRoutes } from '../app/router.tsx'
import { login, requestCurrentUser, resetCurrentUser } from '../auth/currentUser.ts'
import { resetLoginDialog } from '../auth/loginDialog.ts'
import { retryQueue } from '../auth/retryQueue.ts'
import { removeAll } from '../notifications/store.ts'

export type Persona = keyof typeof CREDENTIALS | 'anonymous'

export type RenderRouteOptions = {
  as?: Persona
  /** Extra routes under the layout route, for tests that need a screen of their own (e.g. a throwing one). */
  routes?: RouteObject[]
}

export type RenderRouteResult = RenderResult & { router: DataRouter; user: UserEvent }

/** Clears the client-side module state a page reload would clear. renderRoute() calls it first. */
export function resetClientState(): void {
  resetCurrentUser()
  retryQueue.reset()
  resetLoginDialog()
  removeAll()
}

/** Logs a seeded persona in on the stub (session cookie), then forgets it client-side. */
export async function signIn(persona: Exclude<Persona, 'anonymous'>): Promise<void> {
  const { email, password } = CREDENTIALS[persona]
  await requestCurrentUser() // the first response sets the XSRF-TOKEN cookie that /login needs
  if (!(await login(email, password))) throw new Error(`renderRoute: could not log in as ${persona}`)
  resetCurrentUser()
}

export async function renderRoute(path: string, options: RenderRouteOptions = {}): Promise<RenderRouteResult> {
  const { as = 'anonymous', routes = [] } = options
  resetClientState()
  if (as !== 'anonymous') await signIn(as)

  const { router, app } = bootApp((tree) => createMemoryRouter(tree, { initialEntries: [path] }), buildRoutes(routes))
  onTestFinished(() => router.dispose())
  const user = userEvent.setup()
  return { ...render(app), router, user }
}
