// Port of security/login/toolbar.js + toolbar.tpl.html (AC-AUTH-08).
// Legacy hid the inactive items with ng-show/ng-hide; here they are not rendered.
// P4 (spec §0.2, Q-fix-forms-1): the button-only navbar forms cancel native submission too, so the
// rule holds for every form without depending on today's markup.
import type { MouseEvent } from 'react'
import { useAuth } from './useAuth.ts'

/** The legacy `href="#"` links only display text; keep the markup but don't change the URL. */
function stay(event: MouseEvent) {
  event.preventDefault()
}

export function LoginToolbar() {
  const { currentUser, showLogin, logout } = useAuth()
  return (
    <ul className="nav pull-right">
      <li className="divider-vertical"></li>
      {currentUser && (
        <li>
          <a href="#" onClick={stay}>
            {currentUser.firstName} {currentUser.lastName}
          </a>
        </li>
      )}
      {currentUser && (
        <li className="logout">
          <form className="navbar-form" onSubmit={(event) => event.preventDefault()}>
            <button type="button" className="btn logout" onClick={logout}>
              Log out
            </button>
          </form>
        </li>
      )}
      {!currentUser && (
        <li className="login">
          <form className="navbar-form" onSubmit={(event) => event.preventDefault()}>
            <button type="button" className="btn login" onClick={showLogin}>
              Log in
            </button>
          </form>
        </li>
      )}
    </ul>
  )
}
