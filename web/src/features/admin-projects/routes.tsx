// PLACEHOLDER from cluster 0 (spec §8.1): the routes and guards are final (R13–R15, requireAdminUser);
// cluster 2 replaces the loaders' data and the components.
import type { RouteObject } from 'react-router'
import { requireAdminUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'

async function loader() {
  await requireAdminUser()
  return null
}

function AdminProjectsPlaceholder() {
  return <p>Manage projects: converted by cluster 2.</p>
}

export const routes: RouteObject[] = crudRoutes('/admin/projects', {
  list: { loader, Component: AdminProjectsPlaceholder },
  create: { loader, Component: AdminProjectsPlaceholder },
  edit: { loader, Component: AdminProjectsPlaceholder },
})
