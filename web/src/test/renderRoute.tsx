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
import { server } from './server.ts'

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

export type RecordedRequest = {
  method: string
  pathname: string
  /** The `?q=` query, parsed; undefined when absent. */
  q: unknown
  headers: Headers
  credentials: RequestCredentials
  /** The parsed JSON body; undefined when empty. */
  body: unknown
}

/**
 * Records every request that reaches the stub from now until the end of the test. An observer, not an
 * override: the stub still answers, so this never stands in for api/ (CLAUDE.md).
 */
export function recordRequests(): RecordedRequest[] {
  const recorded: RecordedRequest[] = []
  const listener = ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    const q = url.searchParams.get('q')
    const entry: RecordedRequest = {
      method: request.method,
      pathname: url.pathname,
      q: q === null ? undefined : (JSON.parse(q) as unknown),
      headers: request.headers,
      credentials: request.credentials,
      body: undefined,
    }
    recorded.push(entry)
    void request
      .clone()
      .text()
      .then((text) => {
        entry.body = text === '' ? undefined : (JSON.parse(text) as unknown)
      })
  }
  server.events.on('request:start', listener)
  onTestFinished(() => server.events.removeListener('request:start', listener))
  return recorded
}
