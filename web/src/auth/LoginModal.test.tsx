import { act, getDefaultNormalizer, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { request } from '../api/http.ts'
import { recordRequests, renderRoute } from '../test/renderRoute.tsx'
import { failNext } from '../test/stubControl.ts'
import { getLoginDialogId } from './loginDialog.ts'
import { RetryCancelledError, retryQueue } from './retryQueue.ts'

const exact = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }
const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
const NOT_AUTHORIZED = 'You do not have the necessary access permissions.  Do you want to login as someone else?'

/** Renders the app at a public page, waits until it has loaded, and returns the test handles. */
async function renderAtProjectsInfo(as: 'anonymous' | 'po' | 'dev1' = 'anonymous') {
  const rendered = await renderRoute('/projectsinfo', { as })
  await waitFor(() => expect(rendered.router.state.initialized).toBe(true))
  return rendered
}

function getModal(): HTMLElement {
  const form = document.querySelector('form.login-form')
  if (!(form instanceof HTMLElement)) throw new Error('the login modal is not open')
  return form
}

describe('LoginModal', () => {
  it('AC-AUTH-02: every retry-queue push opens the modal; a push while it is open does not open another (S7)', async () => {
    await renderAtProjectsInfo()
    expect(document.querySelector('.modal')).toBeNull()

    act(() => void retryQueue.pushRetryFn('unauthenticated-client', () => undefined).catch(() => undefined))
    const firstOpening = getLoginDialogId()
    expect(getModal()).toBeInTheDocument()

    act(() => void retryQueue.pushRetryFn('unauthenticated-client', () => undefined).catch(() => undefined))
    expect(document.querySelectorAll('.modal')).toHaveLength(1)
    expect(document.querySelectorAll('.modal-backdrop')).toHaveLength(1)
    expect(getLoginDialogId()).toBe(firstOpening)
  })

  it('AC-AUTH-03: with a queued item, an anonymous user sees "notAuthenticated"', async () => {
    await renderAtProjectsInfo()
    act(() => void retryQueue.pushRetryFn('unauthenticated-client', () => undefined).catch(() => undefined))
    expect(within(getModal()).getByText(NOT_AUTHENTICATED)).toHaveClass('alert alert-warning')
  })

  it('AC-AUTH-03 / D15: an authenticated user whose write gets a 401 sees "notAuthorized"', async () => {
    await renderAtProjectsInfo('dev1')
    await screen.findByRole('button', { name: 'Log out' })
    // D15 (preserved): a non-admin write to projects is a 401, not a 403, so the modal opens.
    act(
      () =>
        void request('POST', '/databases/ascrum/collections/projects', { body: { name: 'x' } }).catch(() => undefined),
    )
    const modal = await waitFor(getModal)
    expect(within(modal).getByText(NOT_AUTHORIZED, exact)).toHaveClass('alert alert-warning')
  })

  it('AC-AUTH-03 / AC-AUTH-08: opened from the toolbar (empty queue) it shows no reason alert', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    expect(modal.querySelector('.alert-warning')).toBeNull()
    expect(within(modal).getByText('Please enter your login details')).toHaveClass('alert alert-info')
    // Legacy markup inside the ui-bootstrap dialog wrapper.
    expect(modal.closest('.modal')).toBeInTheDocument()
    expect(within(modal).getByRole('heading', { name: 'Sign in' }).closest('.modal-header')).toBeInTheDocument()
  })

  it('AC-AUTH-04: Sign in is disabled until the email is valid and the password non-empty', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    const signIn = within(modal).getByRole('button', { name: 'Sign in' })
    expect(signIn).toHaveClass('btn btn-primary login')
    expect(signIn).toBeDisabled()

    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum')
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    expect(signIn).toBeDisabled() // no top-level domain: AngularJS's EMAIL_REGEXP rejects it
    await user.type(within(modal).getByLabelText('E-mail'), '.test')
    expect(signIn).toBeEnabled()
    await user.clear(within(modal).getByLabelText('Password'))
    expect(signIn).toBeDisabled()
  })

  it('AC-AUTH-04 / D19: {user:null} shows login.error.invalidCredentials and keeps the modal open', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'not-the-password')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    expect(
      await within(modal).findByText('Login failed.  Please check your credentials and try again.', exact),
    ).toHaveClass('alert alert-error')
    expect(getModal()).toBe(modal)
  })

  it('AC-AUTH-04 / S14: an HTTP failure shows login.error.serverError with exception "HTTP <status>"', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    failNext('POST', '/login', 500)
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    expect(await within(modal).findByText('There was a problem with authenticating: HTTP 500.')).toHaveClass(
      'alert alert-error',
    )
  })

  it('AC-AUTH-05: success closes the modal and retries the queued items in order', async () => {
    const { user } = await renderAtProjectsInfo()
    const order: string[] = []
    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    act(() => {
      first = retryQueue.pushRetryFn('unauthenticated-client', () => order.push('first'))
      second = retryQueue.pushRetryFn('unauthorized-server', () => order.push('second'))
    })
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'sm@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    await user.click(within(modal).getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(document.querySelector('.modal')).toBeNull())
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(screen.getByRole('link', { name: 'Sam Master' })).toBeInTheDocument()
  })

  it('AC-AUTH-05: Clear empties the fields', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    await user.click(within(modal).getByRole('button', { name: 'Clear' }))
    expect(within(modal).getByLabelText('E-mail')).toHaveValue('')
    expect(within(modal).getByLabelText('Password')).toHaveValue('')
  })

  it("AC-AUTH-05: Cancel rejects every queued item and navigates to '/'", async () => {
    const { router, user } = await renderRoute('/admin/users')
    let outcome: Promise<unknown> = Promise.resolve()
    await waitFor(getModal)
    act(() => {
      // Handled from the start, so the rejection during the click is never "unhandled".
      outcome = retryQueue.pushRetryFn('unauthorized-server', () => 'never').catch((error: unknown) => error)
    })
    await user.click(within(getModal()).getByRole('button', { name: 'Cancel' }))

    expect(await outcome).toBeInstanceOf(RetryCancelledError)
    expect(retryQueue.hasMore()).toBe(false)
    expect(document.querySelector('.modal')).toBeNull()
    await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo')) // '/' → otherwise
  })

  it('AC-AUTH-05: Escape and a backdrop click cancel too (legacy ui-bootstrap dialog behaviour)', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    await user.keyboard('{Escape}')
    expect(document.querySelector('.modal')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const backdrop = document.querySelector('.modal-backdrop')
    if (!(backdrop instanceof HTMLElement)) throw new Error('no backdrop')
    await user.click(backdrop)
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('P4: "Sign in" is the form\'s only submit button; Clear and Cancel are type="button"', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    expect(within(modal).getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit')
    expect(within(modal).getByRole('button', { name: 'Clear' })).toHaveAttribute('type', 'button')
    expect(within(modal).getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button')
  })

  it('AC-AUTH-04 / DSC-2 / P4: Enter in the password field signs in', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum.test')
    await user.type(within(modal).getByLabelText('Password'), 'demo')

    const requests = recordRequests()
    const submits = watchSubmits()
    await user.type(within(modal).getByLabelText('Password'), '{Enter}')

    await waitFor(() => expect(document.querySelector('.modal')).toBeNull())
    expect(screen.getByRole('link', { name: 'Paula Owner' })).toBeInTheDocument()
    expect(requests.filter((r) => r.method === 'POST' && r.pathname === '/login')).toHaveLength(1)
    expect(submits).toEqual([true]) // signed in by script; the native submission was cancelled
  })

  it('AC-AUTH-04 / DSC-2 / P4: Enter with an invalid e-mail does not sign in', async () => {
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    await user.type(within(modal).getByLabelText('E-mail'), 'po@ascrum') // no TLD: invalid (AC-AUTH-04)
    await user.type(within(modal).getByLabelText('Password'), 'demo')
    expect(within(modal).getByRole('button', { name: 'Sign in' })).toBeDisabled()

    const requests = recordRequests()
    const submits = watchSubmits()
    await user.type(within(modal).getByLabelText('E-mail'), '{Enter}')
    await user.type(within(modal).getByLabelText('Password'), '{Enter}')
    // A browser never submits through a disabled default button. Submit anyway, the way any other
    // trigger would, to prove the handler itself refuses while Sign in is disabled.
    await act(async () => getModal().closest('form')?.requestSubmit())

    expect(submits).toEqual([true]) // only the scripted submission; Enter submitted nothing
    expect(requests.filter((r) => r.method === 'POST' && r.pathname === '/login')).toEqual([])
    expect(getModal()).toBe(modal)
    expect(modal.querySelector('.alert-error')).toBeNull()
  })
})

/**
 * P4: records `defaultPrevented` for every submit event that reaches window. The listener sits outside
 * React's root, so it sees each event after the form's onSubmit has run. jsdom never navigates on a
 * native submission, so a cancelled submit event is the only unit-level proof that a browser would not.
 */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

// P6 / DSC-B-1: legacy's ngTrim trimmed `user.email` and `user.password` (password inputs too).
describe('LoginModal: trimming (P6)', () => {
  it('P6 / DSC-B-1: a spaces-only password keeps Sign in disabled; a padded one is sent trimmed and signs in', async () => {
    const requests = recordRequests()
    const { user } = await renderAtProjectsInfo()
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    const modal = getModal()
    const signIn = within(modal).getByRole('button', { name: 'Sign in' })
    const password = within(modal).getByLabelText('Password')
    await user.type(within(modal).getByLabelText('E-mail'), 'sm@ascrum.test')
    await user.type(password, '   ')
    expect(password).toHaveValue('   ') // the input shows what was typed
    expect(signIn).toBeDisabled()

    await user.type(password, 'demo  ')
    expect(password).toHaveValue('   demo  ')
    expect(signIn).toBeEnabled()
    await user.click(signIn)

    await waitFor(() => expect(document.querySelector('.modal')).toBeNull())
    expect(requests.find((r) => r.method === 'POST' && r.pathname === '/login')?.body).toEqual({
      email: 'sm@ascrum.test',
      password: 'demo',
    })
  })
})
