// Port of admin-projects.js routes (R13–R15, spec §5.3): crudRoutes('/admin/projects'), every loader
// guarded by requireAdminUser. Legacy ran the guard alongside the other resolves; here it is awaited
// first, so nothing is fetched for a user who is not (yet) an admin.
import type { RouteObject } from 'react-router'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { projects, users } from '../../api/collections.ts'
import { requireAdminUser } from '../../auth/guards.ts'
import { crudRoutes } from '../../crud/crudRoutes.ts'
import { newProjectDraft, ProjectEdit, projectFormInitial } from './ProjectEdit.tsx'
import { ProjectsAdminList } from './ProjectsAdminList.tsx'

async function listLoader() {
  await requireAdminUser()
  return { projects: await projects.all() }
}

async function newLoader() {
  await requireAdminUser()
  return { initial: newProjectDraft(), users: await users.all() }
}

async function editLoader({ params }: LoaderFunctionArgs) {
  await requireAdminUser()
  const [project, allUsers] = await Promise.all([projects.getById(params.itemId ?? ''), users.all()])
  return { initial: projectFormInitial(project), users: allUsers }
}

function ProjectsAdminListRoute() {
  const data = useLoaderData<typeof listLoader>()
  return <ProjectsAdminList projects={data.projects} />
}

function ProjectEditRoute() {
  const data = useLoaderData<typeof newLoader | typeof editLoader>()
  // Keyed by document: useCrudForm takes `initial` once (crud/useCrudForm.ts).
  return <ProjectEdit key={data.initial.id ?? 'new'} initial={data.initial} users={data.users} />
}

export const routes: RouteObject[] = crudRoutes('/admin/projects', {
  list: { loader: listLoader, Component: ProjectsAdminListRoute },
  create: { loader: newLoader, Component: ProjectEditRoute },
  edit: { loader: editLoader, Component: ProjectEditRoute },
})
