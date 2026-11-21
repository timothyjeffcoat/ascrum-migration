// Port of app/header.tpl.html + HeaderCtrl (app.js): brand, nav, admin dropdown, request spinner,
// login toolbar and breadcrumbs (AC-SHELL-01..05). Legacy hid items with ng-show; here they are not
// rendered.
import { useState, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { usePendingRequests } from '../api/http.ts'
import { LoginToolbar } from '../auth/LoginToolbar.tsx'
import { useAuth } from '../auth/useAuth.ts'
import { breadcrumbsFor } from './breadcrumbs.ts'
import { Breadcrumbs } from './Breadcrumbs.tsx'

/** §11-6: the legacy `/static/img/spinner.gif` becomes base-relative, so it works under any basename. */
const SPINNER_SRC = `${import.meta.env.BASE_URL}img/spinner.gif`

export function Header() {
  const { isAuthenticated, isAdmin } = useAuth()
  const navigate = useNavigate()
  const breadcrumbs = breadcrumbsFor(useLocation().pathname)
  const hasPendingRequests = usePendingRequests()
  const [isAdminOpen, setAdminOpen] = useState(false)

  /** AC-SHELL-03: active when the path is the first breadcrumb. */
  const navClass = (navBarPath: string) => (breadcrumbs[0]?.name === navBarPath ? 'active' : undefined)

  function home() {
    void navigate(isAuthenticated ? '/dashboard' : '/projectsinfo')
  }

  function stay(event: MouseEvent) {
    event.preventDefault() // the legacy spinner link is `href="#"` and only shows the image
  }

  const adminClasses = ['dropdown', navClass('admin'), isAdminOpen ? 'open' : undefined].filter(Boolean).join(' ')

  return (
    <div className="navbar">
      <div className="navbar-inner">
        <a className="brand" onClick={home}>
          AScrum
        </a>
        <ul className="nav">
          <li className={navClass('projectsinfo')}>
            <Link to="/projectsinfo">Current Projects</Link>
          </li>
        </ul>

        {isAuthenticated && (
          <ul className="nav">
            <li className={navClass('projects')}>
              <Link to="/projects">My Projects</Link>
            </li>
            {isAdmin && (
              <li className={adminClasses}>
                <a id="adminmenu" role="button" className="dropdown-toggle" onClick={() => setAdminOpen(!isAdminOpen)}>
                  Admin<b className="caret"></b>
                </a>
                <ul className="dropdown-menu" role="menu" aria-labelledby="adminmenu">
                  <li>
                    <Link tabIndex={-1} to="/admin/projects" onClick={() => setAdminOpen(false)}>
                      Manage Projects
                    </Link>
                  </li>
                  <li>
                    <Link tabIndex={-1} to="/admin/users" onClick={() => setAdminOpen(false)}>
                      Manage Users
                    </Link>
                  </li>
                </ul>
              </li>
            )}
          </ul>
        )}
        {hasPendingRequests && (
          <ul className="nav pull-right">
            <li className="divider-vertical"></li>
            <li>
              <a href="#" onClick={stay}>
                <img src={SPINNER_SRC} />
              </a>
            </li>
          </ul>
        )}
        <LoginToolbar />
      </div>
      <Breadcrumbs breadcrumbs={breadcrumbs} />
    </div>
  )
}
