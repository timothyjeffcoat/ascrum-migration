// Port of sprints.js's crudRouteProvider routes (R7–R9), with identical paths (D6). Legacy had no guard
// here; spec D2/§5.3 guards the whole `/projects/**` tree, so every loader awaits
// requireAuthenticatedUser first and fetches nothing before it resolves.
import type { LoaderFunctionArgs, Params, RouteObject } from 'react-router'
import { productBacklog, sprints } from '../../api/collections.ts'
import type { BacklogItem, Sprint } from '../../api/types.ts'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'
import { SprintEditPage } from './SprintEdit.tsx'
import { SprintsList } from './SprintsList.tsx'

export type SprintsListData = { projectId: string; sprints: Sprint[] }
/** Legacy resolves: `projectId`, `sprint` (new or loaded) and the project's `productBacklog`. */
export type SprintData = { projectId: string; sprint?: Sprint; productBacklog: BacklogItem[] }

function param(params: Params, name: string): string {
  const value = params[name]
  // Unreachable: the route paths always contain the parameter.
  if (value === undefined) throw new Error(`Missing route parameter :${name}`)
  return value
}

async function listLoader({ params }: LoaderFunctionArgs): Promise<SprintsListData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  return { projectId, sprints: await sprints.forProject(projectId) }
}

async function newLoader({ params }: LoaderFunctionArgs): Promise<SprintData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  return { projectId, productBacklog: await productBacklog.forProject(projectId) }
}

async function editLoader({ params }: LoaderFunctionArgs): Promise<SprintData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  const [sprint, backlog] = await Promise.all([
    sprints.getById(param(params, 'itemId')),
    productBacklog.forProject(projectId),
  ])
  return { projectId, sprint, productBacklog: backlog }
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/sprints', {
  list: { loader: listLoader, Component: SprintsList },
  create: { loader: newLoader, Component: SprintEditPage },
  edit: { loader: editLoader, Component: SprintEditPage },
})
