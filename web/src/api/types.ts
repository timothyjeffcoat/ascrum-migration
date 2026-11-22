// App-side document types (spec §5.5). Wire documents carry `_id: {$oid}`; api/ converts them to
// `id?: string` and back. api/ does not fill defaults, so optional fields stay optional (D13).

export type User = {
  id?: string
  email: string
  firstName: string
  lastName: string
  admin?: boolean
  /** Only ever outbound: the stub strips it from every response (D7, A3). */
  password?: string
}

export type Project = {
  id?: string
  name: string
  desc?: string
  productOwner?: string
  scrumMaster?: string
  teamMembers?: string[]
}

export type BacklogItem = {
  id?: string
  projectId: string
  name: string
  desc: string
  priority: number
  estimation: number
}

export type Sprint = {
  id?: string
  projectId: string
  name: string
  capacity: number
  start: string
  end: string
  sprintBacklog?: string[]
}

export type TaskState = 'TODO' | 'IN_DEV' | 'BLOCKED' | 'IN_TEST' | 'DONE'

export type Task = {
  id?: string
  projectId: string
  sprintId: string
  productBacklogItemId: string
  name: string
  desc: string
  estimation: number
  remaining: number
  state: TaskState
  assignedUserId?: string
}

export type CurrentUser = { id: string; email: string; firstName: string; lastName: string; admin: boolean }

/** What a form holds before validation guarantees the required fields. */
export type Draft<T> = { [K in keyof T]?: T[K] }
