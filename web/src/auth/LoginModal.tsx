// Port of security/login/LoginFormController.js + login/form.tpl.html, inside the markup the legacy
// ui-bootstrap $dialog wrapped it in (`div.modal` plus `div.modal-backdrop`). Mounted outside the
// router (spec §4.1) so a guard in an initial loader can open it while the router is still loading.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { ApiError } from '../api/errors.ts'
import { isEmail } from '../crud/validators.ts'
import { getMessage } from '../notifications/messages.ts'
import { getLoginDialogId, getLoginReason, subscribeLoginDialog } from './loginDialog.ts'
import { useAuth } from './useAuth.ts'

export function LoginModal() {
  const dialogId = useSyncExternalStore(subscribeLoginDialog, getLoginDialogId)
  if (dialogId === null) return null
  // A new key per opening: legacy created a new controller (empty form, fresh reason) each time.
  return <LoginForm key={dialogId} />
}

function LoginForm() {
  const { isAuthenticated, login, cancelLogin } = useAuth()
  // AC-AUTH-03: worked out once, when the dialog opens, like the legacy controller did.
  const [authReason] = useState<string | null>(() => {
    if (!getLoginReason()) return null // opened from the toolbar: nothing queued, no reason
    return getMessage(isAuthenticated ? 'login.reason.notAuthorized' : 'login.reason.notAuthenticated')
  })
  const [authError, setAuthError] = useState<string | null>(null)
  // P6 / DSC-B-1: the inputs show the text as typed; the form works with the trimmed text, as
  // AngularJS's ngTrim did for legacy's `user.email` and `user.password` (password included: ngTrim
  // applies to every text-like input). Deriving it keeps both, and "Sign in" sends the trimmed values.
  const [emailText, setEmailText] = useState('')
  const [passwordText, setPasswordText] = useState('')
  const email = emailText.trim()
  const password = passwordText.trim()
  // The legacy form's `required` + `type="email"` validity (AC-AUTH-04).
  const formInvalid = !isEmail(email) || password === ''

  // ui-bootstrap's dialog closed on Escape with no result, which security.js treated as a cancel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelLogin()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [cancelLogin])

  // P7 / DEV-owner-04: one sign-in at a time. Legacy posted /login again on every Enter or click while
  // a slow reply was pending; the port ignores those. A ref, not state, so two submits in the same tick
  // see it. Sign in keeps its legacy markup (no extra `disabled`): the extra presses just do nothing.
  const signingIn = useRef(false)

  function onLogin() {
    if (signingIn.current) return
    signingIn.current = true
    setAuthError(null)
    login(email, password).then(
      (loggedIn) => {
        signingIn.current = false
        if (!loggedIn) setAuthError(getMessage('login.error.invalidCredentials'))
      },
      (error: unknown) => {
        signingIn.current = false
        // S14: legacy interpolated the whole rejected $http response, printing a JSON dump of it
        // (AngularJS 1.2 $interpolate runs toJson; corrected by the wave A audit, DSC-3).
        const exception = error instanceof ApiError ? `HTTP ${error.status}` : String(error)
        setAuthError(getMessage('login.error.serverError', { exception }))
      },
    )
  }

  // P4 / DSC-2: in legacy "Sign in" had no type, so it was the form's default button and Enter in E-mail
  // or Password clicked it. It is type="submit" again and signing in happens here, on the form's submit,
  // whether it came from a click or from Enter. The browser never submits through a disabled default
  // button; the formInvalid check keeps that rule for any other submission (AC-AUTH-04).
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!formInvalid) onLogin()
  }

  function onClear() {
    setEmailText('')
    setPasswordText('')
  }

  return (
    <>
      <div className="modal">
        <form name="form" noValidate className="login-form" onSubmit={onSubmit}>
          <div className="modal-header">
            <h4>Sign in</h4>
          </div>
          <div className="modal-body">
            {authReason && <div className="alert alert-warning">{authReason}</div>}
            {authError && <div className="alert alert-error">{authError}</div>}
            <div className="alert alert-info">Please enter your login details</div>
            {/* htmlFor/id are additions to the legacy markup so the fields have accessible names. */}
            <label htmlFor="login-email">E-mail</label>
            <input
              id="login-email"
              name="login"
              type="email"
              value={emailText}
              onChange={(event) => setEmailText(event.target.value)}
              required
              autoFocus
            />
            <label htmlFor="login-pass">Password</label>
            <input
              id="login-pass"
              name="pass"
              type="password"
              value={passwordText}
              onChange={(event) => setPasswordText(event.target.value)}
              required
            />
          </div>
          <div className="modal-footer">
            <button type="submit" className="btn btn-primary login" disabled={formInvalid}>
              Sign in
            </button>{' '}
            <button type="button" className="btn clear" onClick={onClear}>
              Clear
            </button>{' '}
            <button type="button" className="btn btn-warning cancel" onClick={cancelLogin}>
              Cancel
            </button>
          </div>
        </form>
      </div>
      {/* ui-bootstrap's backdrop click also closed the dialog as a cancel. */}
      <div className="modal-backdrop" onClick={cancelLogin} />
    </>
  )
}
