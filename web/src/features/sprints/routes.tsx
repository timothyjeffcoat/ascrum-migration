// PLACEHOLDER from cluster 0 (spec §8.1): the routes and guards are final (R7–R9, newly guarded per
// D2); cluster 4 replaces the loaders' data and the components.
import type { RouteObject } from 'react-router'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'

async function loader() {
  await requireAuthenticatedUser()
  return null
}

function SprintsPlaceholder() {
  return <p>Sprints: converted by cluster 4.</p>
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/sprints', {
  list: { loader, Component: SprintsPlaceholder },
  create: { loader, Component: SprintsPlaceholder },
  edit: { loader, Component: SprintsPlaceholder },
})
