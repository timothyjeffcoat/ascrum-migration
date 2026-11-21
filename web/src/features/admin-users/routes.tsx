// PLACEHOLDER from cluster 0 (spec §8.1): the routes and guards are final (R16–R18, requireAdminUser);
// cluster 1 replaces the loaders' data and the components.
import type { RouteObject } from 'react-router'
import { requireAdminUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'

async function loader() {
  await requireAdminUser()
  return null
}

function AdminUsersPlaceholder() {
  return <p>Manage users: converted by cluster 1.</p>
}

export const routes: RouteObject[] = crudRoutes('/admin/users', {
  list: { loader, Component: AdminUsersPlaceholder },
  create: { loader, Component: AdminUsersPlaceholder },
  edit: { loader, Component: AdminUsersPlaceholder },
})
