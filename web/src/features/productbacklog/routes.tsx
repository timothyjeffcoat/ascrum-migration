// Port of productbacklog.js's crudRouteProvider routes (R4–R6), with identical paths (D6). Legacy had
// no guard here; spec D2/§5.3 guards the whole `/projects/**` tree, so every loader awaits
// requireAuthenticatedUser first.
import type { LoaderFunctionArgs, Params, RouteObject } from 'react-router'
import { productBacklog } from '../../api/collections.ts'
import type { BacklogItem } from '../../api/types.ts'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'
import { BacklogItemEditPage } from './BacklogItemEdit.tsx'
import { BacklogList } from './BacklogList.tsx'

export type BacklogListData = { projectId: string; backlog: BacklogItem[] }
export type BacklogItemData = { projectId: string; backlogItem?: BacklogItem }

function param(params: Params, name: string): string {
  const value = params[name]
  // Unreachable: the route paths always contain the parameter.
  if (value === undefined) throw new Error(`Missing route parameter :${name}`)
  return value
}

async function listLoader({ params }: LoaderFunctionArgs): Promise<BacklogListData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  return { projectId, backlog: await productBacklog.forProject(projectId) }
}

async function newLoader({ params }: LoaderFunctionArgs): Promise<BacklogItemData> {
  await requireAuthenticatedUser()
  return { projectId: param(params, 'projectId') }
}

async function editLoader({ params }: LoaderFunctionArgs): Promise<BacklogItemData> {
  await requireAuthenticatedUser()
  return { projectId: param(params, 'projectId'), backlogItem: await productBacklog.getById(param(params, 'itemId')) }
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/productbacklog', {
  list: { loader: listLoader, Component: BacklogList },
  create: { loader: newLoader, Component: BacklogItemEditPage },
  edit: { loader: editLoader, Component: BacklogItemEditPage },
})
