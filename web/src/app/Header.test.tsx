import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { request } from '../api/http.ts'
import { renderRoute, type Persona } from '../test/renderRoute.tsx'

async function renderShell(path: string, as: Persona = 'anonymous') {
  const rendered = await renderRoute(path, { as })
  await waitFor(() => expect(rendered.router.state.initialized).toBe(true))
  if (as !== 'anonymous') await screen.findByRole('button', { name: 'Log out' })
  const navbar = document.querySelector('.navbar')
  if (!(navbar instanceof HTMLElement)) throw new Error('no navbar')
  return { ...rendered, navbar }
}

function breadcrumbBar(): HTMLElement {
  const bar = document.querySelector('ul.breadcrumb')
  if (!(bar instanceof HTMLElement)) throw new Error('no breadcrumb bar')
  return bar
}

describe('Header', () => {
  it('class parity: the shell uses the legacy navbar, nav and breadcrumb classes', async () => {
    const { navbar } = await renderShell('/projectsinfo')
    expect(navbar.firstElementChild).toHaveClass('navbar-inner')
    expect(within(navbar).getByText('AScrum')).toHaveClass('brand')
    expect(within(navbar).getByRole('link', { name: 'Current Projects' }).closest('ul')).toHaveClass('nav')
    expect(breadcrumbBar()).toHaveClass('breadcrumb')
  })

  it('AC-SHELL-01: the brand goes to /projectsinfo when anonymous', async () => {
    const { router, user } = await renderShell('/projectsinfo')
    await router.navigate('/admin') // anywhere else first; unknown → /projectsinfo
    await user.click(screen.getByText('AScrum'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo'))
  })

  it('AC-SHELL-01: the brand goes to /dashboard when authenticated', async () => {
    const { router, user } = await renderShell('/projectsinfo', 'dev1')
    await user.click(screen.getByText('AScrum'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
  })

  it('AC-SHELL-02: anonymous users see only "Current Projects"', async () => {
    const { navbar } = await renderShell('/projectsinfo')
    expect(within(navbar).getByRole('link', { name: 'Current Projects' })).toHaveAttribute('href', '/projectsinfo')
    expect(within(navbar).queryByRole('link', { name: 'My Projects' })).toBeNull()
    expect(within(navbar).queryByRole('button', { name: /Admin/ })).toBeNull()
  })

  it('AC-SHELL-02: authenticated non-admins also see "My Projects", but no Admin menu', async () => {
    const { navbar } = await renderShell('/projectsinfo', 'po')
    expect(within(navbar).getByRole('link', { name: 'My Projects' })).toHaveAttribute('href', '/projects')
    expect(within(navbar).queryByRole('button', { name: /Admin/ })).toBeNull()
  })

  it('AC-SHELL-02: admins get the Admin dropdown, toggled by click and closed when an item is chosen', async () => {
    const { navbar, router, user } = await renderShell('/projectsinfo', 'admin')
    const toggle = within(navbar).getByRole('button', { name: /Admin/ })
    const dropdown = toggle.closest('li')
    expect(toggle).toHaveClass('dropdown-toggle')
    expect(dropdown).toHaveClass('dropdown')
    expect(dropdown).not.toHaveClass('open')

    await user.click(toggle)
    expect(dropdown).toHaveClass('open')
    await user.click(toggle)
    expect(dropdown).not.toHaveClass('open')

    await user.click(toggle)
    const menu = within(navbar).getByRole('menu')
    expect(menu).toHaveClass('dropdown-menu')
    expect(within(menu).getByRole('link', { name: 'Manage Projects' })).toHaveAttribute('href', '/admin/projects')
    await user.click(within(menu).getByRole('link', { name: 'Manage Users' }))
    expect(dropdown).not.toHaveClass('open')
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users'))
  })

  it('AC-SHELL-03: a nav item is active when its path is the first path segment', async () => {
    const { navbar, router } = await renderShell('/projectsinfo', 'admin')
    const item = (name: string | RegExp) =>
      within(navbar)
        .getByRole(name instanceof RegExp ? 'button' : 'link', { name })
        .closest('li')
    expect(item('Current Projects')).toHaveClass('active')
    expect(item('My Projects')).not.toHaveClass('active')

    await act(() => router.navigate('/projects/123/sprints'))
    expect(item('My Projects')).toHaveClass('active')
    expect(item('Current Projects')).not.toHaveClass('active')

    await act(() => router.navigate('/admin/projects/new'))
    expect(item(/Admin/)).toHaveClass('active')
    expect(item('My Projects')).not.toHaveClass('active')
  })

  it('AC-SHELL-04: one breadcrumb per raw path segment; all but the last are links', async () => {
    await renderShell('/projects/abc123/sprints/def456/tasks', 'dev1')
    const items = within(breadcrumbBar()).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['/projects', '/abc123', '/sprints', '/def456', '/tasks'])
    expect(items.every((li) => li.firstElementChild?.classList.contains('divider'))).toBe(true)
    const links = within(breadcrumbBar()).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects',
      '/projects/abc123',
      '/projects/abc123/sprints',
      '/projects/abc123/sprints/def456',
    ])
    expect(within(items[4] as HTMLElement).queryByRole('link')).toBeNull()
  })

  it('AC-SHELL-04 (legacy breadcrumbs: not exposed before route change success): crumbs update only after the navigation completes', async () => {
    const { router } = await renderShell('/projectsinfo')
    void router.navigate('/projects/p1/productbacklog') // guarded: waits for a login
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(router.state.navigation.location?.pathname).toBe('/projects/p1/productbacklog')
    expect(
      within(breadcrumbBar())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['/projectsinfo'])
  })

  it('AC-SHELL-05: the spinner (base-relative src) shows while requests are pending', async () => {
    await renderShell('/projectsinfo')
    expect(document.querySelector('img')).toBeNull()

    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = request('GET', '/databases/ascrum/collections/projects')
    })
    const spinner = screen.getByRole('img')
    expect(spinner).toHaveAttribute('src', '/img/spinner.gif') // BASE_URL is '/' in tests
    expect(spinner.closest('ul')).toHaveClass('nav pull-right')

    await act(() => inFlight)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('AC-SHELL-06: an unknown path redirects to /projectsinfo', async () => {
    const { router } = await renderShell('/no/such/page')
    expect(router.state.location.pathname).toBe('/projectsinfo')
    await act(() => router.navigate('/'))
    expect(router.state.location.pathname).toBe('/projectsinfo')
  })
})
