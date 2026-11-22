// Legacy common/security/login/login-toolbar.spec.js, rendered inside the real shell, plus AC-AUTH-08.
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { recordRequests, renderRoute, waitForShell, type Persona } from '../test/renderRoute.tsx'

async function renderToolbar(as: Persona = 'anonymous') {
  const rendered = await renderRoute('/projectsinfo', { as })
  await waitForShell(rendered.router) // the real header, not the first-load copy (DEV-foundation-06)
  if (as !== 'anonymous') await screen.findByRole('button', { name: 'Log out' })
  const toolbar = screen.getAllByRole('list').find((ul) => ul.querySelector('li.divider-vertical + li'))
  if (!toolbar) throw new Error('login toolbar not found')
  return { ...rendered, toolbar }
}

describe('legacy login-toolbar cases', () => {
  it('should attach stuff to the scope', async () => {
    // Adapted: the toolbar reads the user from AuthProvider and wires Log in / Log out to it.
    const { toolbar } = await renderToolbar('po')
    expect(toolbar).toHaveClass('nav pull-right')
    expect(within(toolbar).getByRole('button', { name: 'Log out' })).toHaveClass('btn logout')
  })

  it('should display a link with the current user name, when authenticated', async () => {
    const { toolbar } = await renderToolbar('po')
    expect(within(toolbar).getByRole('link')).toHaveTextContent(/^Paula Owner$/)
  })

  it('should not display a link with the current user name, when not authenticated', async () => {
    const { toolbar } = await renderToolbar()
    expect(within(toolbar).queryByRole('link')).toBeNull()
  })

  it('should display login when user is not authenticated', async () => {
    const { toolbar } = await renderToolbar()
    expect(within(toolbar).getByRole('button', { name: 'Log in' })).toHaveClass('btn login')
    expect(within(toolbar).queryByRole('button', { name: 'Log out' })).toBeNull()
  })

  it('should display logout when user is authenticated', async () => {
    const { toolbar } = await renderToolbar('dev2')
    expect(within(toolbar).getByRole('button', { name: 'Log out' })).toBeInTheDocument()
    expect(within(toolbar).queryByRole('button', { name: 'Log in' })).toBeNull()
  })

  it('should call logout when the logout button is clicked', async () => {
    const { toolbar, user } = await renderToolbar('dev2')
    const seen = recordRequests()
    await user.click(within(toolbar).getByRole('button', { name: 'Log out' }))
    await waitFor(() => expect(seen.map((r) => r.pathname)).toContain('/logout'))
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })

  it('should call login when the login button is clicked', async () => {
    const { toolbar, user } = await renderToolbar()
    await user.click(within(toolbar).getByRole('button', { name: 'Log in' }))
    expect(document.querySelector('form.login-form')).toBeInTheDocument()
  })
})

describe('LoginToolbar', () => {
  it('AC-AUTH-08: authenticated → "First Last" and "Log out"; otherwise "Log in", which opens the modal with no reason', async () => {
    const { toolbar } = await renderToolbar('sm')
    expect(within(toolbar).getByRole('link', { name: 'Sam Master' })).toHaveAttribute('href', '#')
    expect(within(toolbar).getByRole('button', { name: 'Log out' }).closest('li')).toHaveClass('logout')
    expect(within(toolbar).getByRole('button', { name: 'Log out' }).closest('form')).toHaveClass('navbar-form')
  })
})

/** Records `defaultPrevented` for each submit reaching window (after React's onSubmit), as in PR #17. */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

function formOf(toolbar: HTMLElement, name: string): HTMLFormElement {
  const form = within(toolbar).getByRole('button', { name }).closest('form')
  if (!form) throw new Error(`"${name}" is not in a form`)
  return form
}

describe('LoginToolbar: native submission (P4)', () => {
  it('P4: the login toolbar forms cancel native submission', async () => {
    // Button-only forms: no browser trigger submits them today, so submit directly, the way any other
    // trigger would (Q-fix-forms-1). jsdom never navigates; a cancelled submit event is the proof.
    const anonymous = await renderToolbar()
    const loginSubmits = watchSubmits()
    const loginRequests = recordRequests()
    formOf(anonymous.toolbar, 'Log in').requestSubmit()
    expect(loginSubmits).toEqual([true])
    expect(loginRequests).toEqual([])
    anonymous.unmount()

    const signedIn = await renderToolbar('po')
    const logoutSubmits = watchSubmits()
    const logoutRequests = recordRequests()
    formOf(signedIn.toolbar, 'Log out').requestSubmit()
    expect(logoutSubmits).toEqual([true])
    expect(logoutRequests).toEqual([])
    expect(within(signedIn.toolbar).getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })
})
