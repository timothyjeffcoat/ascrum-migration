// Port of tasks.js's crudRouteProvider routes (R10–R12), with identical paths (D6). Legacy had no guard
// here; spec D2/§5.3 guards the whole `/projects/**` tree, so every loader awaits
// requireAuthenticatedUser first and fetches nothing before it resolves.
// Legacy relied on undeclared module dependencies (inventory: `tasks` used Sprints, ProductBacklog,
// Projects and Users without declaring them); here they are explicit imports.
import type { LoaderFunctionArgs, Params, RouteObject } from 'react-router'
import { productBacklog, projects, sprints, tasks, users } from '../../api/collections.ts'
import type { BacklogItem, Task, User } from '../../api/types.ts'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'
import { TaskEditPage } from './TaskEdit.tsx'
import { TasksList } from './TasksList.tsx'

export type TasksListData = { projectId: string; sprintId: string; tasks: Task[] }
/** Legacy resolves: `task` (new or loaded), `sprintBacklogItems` and `teamMembers`. */
export type TaskData = {
  projectId: string
  sprintId: string
  task?: Task
  sprintBacklogItems: BacklogItem[]
  teamMembers: User[]
}

function param(params: Params, name: string): string {
  const value = params[name]
  // Unreachable: the route paths always contain the parameter.
  if (value === undefined) throw new Error(`Missing route parameter :${name}`)
  return value
}

/** Legacy `sprintBacklogItems`: Sprints.getById(sprintId) → ProductBacklog.getByIds(sprint.sprintBacklog). */
async function sprintBacklogItems(sprintId: string): Promise<BacklogItem[]> {
  const sprint = await sprints.getById(sprintId)
  // A sprint saved without the field has no items (the D13 rule for missing arrays, §5.6).
  return productBacklog.getByIds(sprint.sprintBacklog ?? [])
}

/** Legacy `teamMembers`: Projects.getById(projectId) → Users.getByIds(project.teamMembers). */
async function teamMembers(projectId: string): Promise<User[]> {
  const project = await projects.getById(projectId)
  // D13: a project without `teamMembers` has no team (legacy sent `$in: undefined`).
  return users.getByIds(project.teamMembers ?? [])
}

async function listLoader({ params }: LoaderFunctionArgs): Promise<TasksListData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  const sprintId = param(params, 'sprintId')
  return { projectId, sprintId, tasks: await tasks.forSprint(sprintId) }
}

async function newLoader({ params }: LoaderFunctionArgs): Promise<TaskData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  const sprintId = param(params, 'sprintId')
  const [items, team] = await Promise.all([sprintBacklogItems(sprintId), teamMembers(projectId)])
  return { projectId, sprintId, sprintBacklogItems: items, teamMembers: team }
}

async function editLoader({ params }: LoaderFunctionArgs): Promise<TaskData> {
  await requireAuthenticatedUser()
  const projectId = param(params, 'projectId')
  const sprintId = param(params, 'sprintId')
  const [task, items, team] = await Promise.all([
    tasks.getById(param(params, 'itemId')),
    sprintBacklogItems(sprintId),
    teamMembers(projectId),
  ])
  return { projectId, sprintId, task, sprintBacklogItems: items, teamMembers: team }
}

export const routes: RouteObject[] = crudRoutes('/projects/:projectId/sprints/:sprintId/tasks', {
  list: { loader: listLoader, Component: TasksList },
  create: { loader: newLoader, Component: TaskEditPage },
  edit: { loader: editLoader, Component: TaskEditPage },
})
