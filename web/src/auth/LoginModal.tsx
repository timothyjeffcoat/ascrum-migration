// Port of security/login/LoginFormController.js + login/form.tpl.html, inside the markup the legacy
// ui-bootstrap $dialog wrapped it in (`div.modal` plus `div.modal-backdrop`). Mounted outside the
// router (spec §4.1) so a guard in an initial loader can open it while the router is still loading.
import { useEffect, useState, useSyncExternalStore } from 'react'
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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

  function onLogin() {
    setAuthError(null)
    login(email, password).then(
      (loggedIn) => {
        if (!loggedIn) setAuthError(getMessage('login.error.invalidCredentials'))
      },
      (error: unknown) => {
        // S14: legacy interpolated the rejected response object and printed "[object Object]".
        const exception = error instanceof ApiError ? `HTTP ${error.status}` : String(error)
        setAuthError(getMessage('login.error.serverError', { exception }))
      },
    )
  }

  function onClear() {
    setEmail('')
    setPassword('')
  }

  return (
    <>
      <div className="modal">
        <form name="form" noValidate className="login-form">
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
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
            <label htmlFor="login-pass">Password</label>
            <input
              id="login-pass"
              name="pass"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-primary login" onClick={onLogin} disabled={formInvalid}>
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
