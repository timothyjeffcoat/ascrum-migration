// Port of the `dashboard` module's route (dashboard/dashboard.js, R2): `/dashboard`.
// D4 fixed: legacy had no guard although it is "My" data and the brand's target when logged in; here
// the loader awaits requireAuthenticatedUser() before fetching anything.
// D2 preserved: legacy's two resolves fetched ALL projects and ALL tasks ("TODO: need to know the
// current user here"); per-user filtering is an unfinished feature and stays unfinished (spec §1).
import type { RouteObject } from 'react-router'
import { projects, tasks } from '../../api/collections.ts'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { Dashboard, type DashboardData } from './Dashboard.tsx'

async function loader(): Promise<DashboardData> {
  await requireAuthenticatedUser()
  // Legacy resolved both in parallel ($routeProvider waits for every resolve).
  const [allProjects, allTasks] = await Promise.all([projects.all(), tasks.all()])
  return { projects: allProjects, tasks: allTasks }
}

export const routes: RouteObject[] = [{ path: '/dashboard', loader, Component: Dashboard }]
