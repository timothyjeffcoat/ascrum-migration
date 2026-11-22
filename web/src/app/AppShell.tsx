// The legacy index.html body: header, notifications, then the view (spec §4.1 root route element).
import { Outlet } from 'react-router'
import { Header } from './Header.tsx'
import { NotificationsOutlet } from './NotificationsOutlet.tsx'

type AppShellProps = {
  /** True while the router's first navigation is still loading (the root route's HydrateFallback). */
  firstLoad?: boolean
}

export function AppShell({ firstLoad = false }: AppShellProps) {
  return (
    <>
      <Header firstLoad={firstLoad} />
      <NotificationsOutlet />
      <div className="container-fluid">
        <Outlet />
      </div>
    </>
  )
}
