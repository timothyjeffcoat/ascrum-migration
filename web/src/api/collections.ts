// Port of common/resources/{users,projects,backlog,sprints,tasks}.js: one typed collection each, plus
// the queries live code actually uses. D11: Tasks.forUser / forProductBacklogItem queried field names
// that tasks don't have; they and the other unused queries (Projects.forUser, Tasks.forProject) are
// not ported (spec §5.9).
import { collection } from './collection.ts'
import type { BacklogItem, Project, Sprint, Task, User } from './types.ts'

export const users = collection<User>('users')

export const projects = collection<Project>('projects')

const backlogCollection = collection<BacklogItem>('productbacklog')
export const productBacklog = {
  ...backlogCollection,
  forProject: (projectId: string) => backlogCollection.query({ projectId }),
}

const sprintsCollection = collection<Sprint>('sprints')
export const sprints = {
  ...sprintsCollection,
  forProject: (projectId: string) => sprintsCollection.query({ projectId }),
}

const tasksCollection = collection<Task>('tasks')
export const tasks = {
  ...tasksCollection,
  forSprint: (sprintId: string) => tasksCollection.query({ sprintId }),
}
