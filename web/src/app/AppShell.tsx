// The legacy index.html body: header, notifications, then the view (spec §4.1 root route element).
import { Outlet } from 'react-router'
import { Header } from './Header.tsx'
import { NotificationsOutlet } from './NotificationsOutlet.tsx'

export function AppShell() {
  return (
    <>
      <Header />
      <NotificationsOutlet />
      <div className="container-fluid">
        <Outlet />
      </div>
    </>
  )
}
