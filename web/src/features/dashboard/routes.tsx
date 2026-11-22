// PLACEHOLDER from cluster 0 (spec §8.1): the route and guard are final (R2, guarded per D4);
// cluster 5 replaces the loader's data and the component.
import type { RouteObject } from 'react-router'
import { requireAuthenticatedUser } from '../../auth/guards.ts'

async function loader() {
  await requireAuthenticatedUser()
  return null
}

function DashboardPlaceholder() {
  return <p>Dashboard: converted by cluster 5.</p>
}

export const routes: RouteObject[] = [{ path: '/dashboard', loader, Component: DashboardPlaceholder }]
