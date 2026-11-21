// PLACEHOLDER from cluster 0 (spec §8.1): the routes and guards are final (R10–R12, newly guarded per
// D2); cluster 4 replaces the loaders' data and the components.
import type { RouteObject } from 'react-router'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'

async function loader() {
  await requireAuthenticatedUser()
  return null
}

function TasksPlaceholder() {
  return <p>Tasks: converted by cluster 4.</p>
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/sprints/:sprintId/tasks', {
  list: { loader, Component: TasksPlaceholder },
  create: { loader, Component: TasksPlaceholder },
  edit: { loader, Component: TasksPlaceholder },
})
