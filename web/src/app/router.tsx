// The route tree (spec §4.1). Every feature's routes have flat absolute paths (spec §4.3) and sit under
// one pathless layout route whose errorElement renders errors INSIDE the shell.
import { redirect, type RouteObject } from 'react-router'
import { routes as adminProjects } from '../features/admin-projects/routes.tsx'
import { routes as adminUsers } from '../features/admin-users/routes.tsx'
import { routes as dashboard } from '../features/dashboard/routes.tsx'
import { routes as productBacklog } from '../features/productbacklog/routes.tsx'
import { routes as projects } from '../features/projects/routes.tsx'
import { routes as projectsInfo } from '../features/projectsinfo/routes.tsx'
import { routes as sprints } from '../features/sprints/routes.tsx'
import { routes as tasks } from '../features/tasks/routes.tsx'
import { AppShell } from './AppShell.tsx'
import { RouteError } from './RouteError.tsx'

export const featureRoutes: RouteObject[] = [
  ...projectsInfo,
  ...dashboard,
  ...projects,
  ...productBacklog,
  ...sprints,
  ...tasks,
  ...adminProjects,
  ...adminUsers,
]

/**
 * While the first navigation's loaders run (for example a guard waiting for the login dialog), the
 * shell renders around an empty content area, as legacy showed the header around an empty ng-view.
 * No breadcrumbs yet: legacy built them on the first `$routeChangeSuccess` (AC-SHELL-04).
 */
function ShellDuringFirstLoad() {
  return <AppShell firstLoad />
}

function toProjectsInfo() {
  return redirect('/projectsinfo')
}

/** The app's route tree; tests may add routes of their own (src/test/renderRoute.tsx). */
export function buildRoutes(extraRoutes: RouteObject[] = []): RouteObject[] {
  return [
    {
      path: '/',
      element: <AppShell />,
      HydrateFallback: ShellDuringFirstLoad,
      children: [
        {
          errorElement: <RouteError />,
          // Legacy `otherwise({redirectTo:'/projectsinfo'})` (AC-SHELL-06). It also caught '/', where
          // cancel and logout land; '*' doesn't match '/' here, so the index route covers it.
          children: [
            ...extraRoutes,
            ...featureRoutes,
            { index: true, loader: toProjectsInfo },
            { path: '*', loader: toProjectsInfo },
          ],
        },
      ],
    },
  ]
}
