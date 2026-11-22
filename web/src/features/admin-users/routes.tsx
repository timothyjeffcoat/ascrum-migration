// Port of admin/users/admin-users.js: `crudRouteProvider.routesFor('Users', 'admin')`, R16–R18, every
// route guarded by requireAdminUser (spec §5.3).
import type { RouteObject } from 'react-router'
import { crudRoutes } from '../../crud/crudRoutes.ts'
import { editUserLoader, newUserLoader, UserEditRoute } from './UserEdit.tsx'
import { UsersList, usersListLoader } from './UsersList.tsx'

export const routes: RouteObject[] = crudRoutes('/admin/users', {
  list: { loader: usersListLoader, Component: UsersList },
  create: { loader: newUserLoader, Component: UserEditRoute },
  edit: { loader: editUserLoader, Component: UserEditRoute },
})
