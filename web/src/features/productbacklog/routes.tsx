// PLACEHOLDER from cluster 0 (spec §8.1): the routes and guards are final (R4–R6, newly guarded per
// D2); cluster 3 replaces the loaders' data and the components.
import type { RouteObject } from 'react-router'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'

async function loader() {
  await requireAuthenticatedUser()
  return null
}

function ProductBacklogPlaceholder() {
  return <p>Product backlog: converted by cluster 3.</p>
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/productbacklog', {
  list: { loader, Component: ProductBacklogPlaceholder },
  create: { loader, Component: ProductBacklogPlaceholder },
  edit: { loader, Component: ProductBacklogPlaceholder },
})
