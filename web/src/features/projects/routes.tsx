// PLACEHOLDER from cluster 0 (spec §8.1): the route and guard are final (R3, requireAuthenticatedUser);
// cluster 3 replaces the loader's data and the component.
import type { RouteObject } from 'react-router'
import { requireAuthenticatedUser } from '../../auth/guards.ts'

async function loader() {
  await requireAuthenticatedUser()
  return null
}

function ProjectsPlaceholder() {
  return <p>My projects: converted by cluster 3.</p>
}

export const routes: RouteObject[] = [{ path: '/projects', loader, Component: ProjectsPlaceholder }]
