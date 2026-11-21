// Risk §11-4 (router v7 data mode), which gates wave A (spec §8.1). Each test runs the real
// composition from app/bootApp.tsx (the same code main.tsx runs) with a memory router.
import { getDefaultNormalizer, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ApiError } from '../api/errors.ts'
import { requireAdminUser } from '../auth/guards.ts'
import { getCurrent, pushForNextRoute } from '../notifications/store.ts'
import { renderRoute, resetClientState } from '../test/renderRoute.tsx'
import { bootApp } from './bootApp.tsx'
import { USER } from '../../stub/seed.ts'

const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const NOT_AUTHORIZED = 'You do not have the necessary access permissions.  Do you want to login as someone else?'

function breadcrumbNames(): string[] {
  const bar = document.querySelector('ul.breadcrumb')
  return Array.from(bar?.querySelectorAll('li') ?? []).map((li) => li.textContent.replace('/', ''))
}

describe('§11-4 router v7 data mode', () => {
  it('§11-4 / §4.1: the login modal sits outside RouterProvider, so a guard in an initial loader can open it while the router renders nothing at all', async () => {
    // No shell here: while the first loader waits, the router renders only an empty fallback. A modal
    // mounted anywhere inside the route tree could not appear, and the guard would wait forever.
    resetClientState()
    const tree = [
      {
        path: '/',
        HydrateFallback: () => null,
        loader: async () => {
          await requireAdminUser()
          return null
        },
        Component: () => <p>guarded content</p>,
      },
    ]
    const { router, app } = bootApp((routes) => createMemoryRouter(routes, { initialEntries: ['/'] }), tree)
    onTestFinished(() => router.dispose())
    const { container } = render(app)
    const user = userEvent.setup()

    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    expect(container.firstElementChild).toBe(modal) // rendered by AppRoot, before RouterProvider's output
    expect(screen.queryByText('guarded content')).toBeNull()

    await user.type(within(modal).getByLabelText('E-mail'), 'admin@abc.com')
    await user.type(within(modal).getByLabelText('Password'), 'changeme')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('guarded content')).toBeInTheDocument()
  })

  it('§11-4 / §4.1 / AC-AUTH-09: reloading a guarded deep link while logged out opens the login modal, and logging in as admin completes the original navigation', async () => {
    const { router, user } = await renderRoute('/admin/users')

    // The guard in the INITIAL loader opened the modal, although no route has rendered yet.
    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    expect(within(modal).getByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
    expect(router.state.initialized).toBe(false)
    // The shell is already there around an empty content area (legacy header + empty ng-view).
    expect(screen.getByText('AScrum')).toHaveClass('brand')

    await user.type(within(modal).getByLabelText('E-mail'), 'admin@abc.com')
    await user.type(within(modal).getByLabelText('Password'), 'changeme')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    // The original navigation completed, without a reload: same router, now initialized at the deep link.
    await waitFor(() => expect(router.state.initialized).toBe(true))
    expect(router.state.location.pathname).toBe('/admin/users')
    expect(router.state.errors).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(breadcrumbNames()).toEqual(['admin', 'users'])
    expect(screen.getByRole('button', { name: /Admin/ })).toBeInTheDocument()
  })

  it('§11-4 / AC-AUTH-03: a non-admin deep link shows the "not authorized" reason; Cancel goes to / (and on to /projectsinfo) without an error', async () => {
    const { router, user } = await renderRoute('/admin/users', { as: 'dev1' })

    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    // The legacy string has two spaces after the full stop; keep them when matching.
    const exact = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }
    expect(within(modal).getByText(NOT_AUTHORIZED, exact)).toHaveClass('alert alert-warning')

    await user.click(within(modal).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo'))
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    // The cancelled guard's navigation was superseded by the navigation to '/', so nothing reports it.
    expect(document.querySelector('.alert')).toBeNull()
  })

  it('§11-4 / AC-AUTH-06: on a later navigation the guard waits with the previous view in place, then completes after login', async () => {
    const { router, user } = await renderRoute('/projectsinfo')
    await waitFor(() => expect(router.state.initialized).toBe(true))

    void router.navigate('/projects')

    const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
    expect(router.state.navigation.state).toBe('loading')
    expect(router.state.location.pathname).toBe('/projectsinfo') // AC-SHELL-04: crumbs not yet updated
    expect(breadcrumbNames()).toEqual(['projectsinfo'])

    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(breadcrumbNames()).toEqual(['projects'])
    expect(screen.getByRole('link', { name: 'My Projects' }).closest('li')).toHaveClass('active')
  })

  it('§11-4 / AC-NOT-01: router.subscribe rotates the notifications BEFORE the new route renders', async () => {
    const seenDuringFirstRender: string[][] = []
    function Probe() {
      // Reads the store during render, so it sees whatever state the rotation left.
      if (seenDuringFirstRender.length === 0) seenDuringFirstRender.push(getCurrent().map((n) => n.message))
      return <p>probe</p>
    }
    const { router } = await renderRoute('/projectsinfo', { routes: [{ path: '/probe', Component: Probe }] })
    await waitFor(() => expect(router.state.initialized).toBe(true))

    pushForNextRoute('crud.user.save.success', 'success', { id: USER.po })
    await router.navigate('/probe')

    expect(await screen.findByText('probe', { selector: 'p' })).toBeInTheDocument()
    expect(seenDuringFirstRender[0]).toEqual([`A user with id '${USER.po}' was saved successfully.`])
  })

  it("§11-4 / AC-NOT-04: RouteError's notification lands after the rotation, so it survives; the next navigation clears both", async () => {
    const failing = {
      path: '/fails',
      loader: () => Promise.reject(new ApiError(500)),
      Component: () => <p>never rendered</p>,
    }
    const { router } = await renderRoute('/projectsinfo', { routes: [failing] })
    await waitFor(() => expect(router.state.initialized).toBe(true))

    pushForNextRoute('crud.project.save.success', 'success', { id: 'p1' })
    await router.navigate('/fails')

    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
    expect(screen.getByText("A project with id 'p1' was saved successfully.")).toHaveClass('alert alert-success')
    expect(screen.queryByText('never rendered')).not.toBeInTheDocument()
    expect(screen.getByText('AScrum')).toBeInTheDocument() // the shell stays (S5)

    await router.navigate('/projectsinfo')
    await waitFor(() => expect(document.querySelector('.alert')).toBeNull())
  })
})
