// Port of the `projects` module's route (projects/projects.js, R3): `/projects`, guarded by
// requireAuthenticatedUser, resolving all projects.
import type { RouteObject } from 'react-router'
import { projects } from '../../api/collections.ts'
import type { Project } from '../../api/types.ts'
import { requireAuthenticatedUser } from '../../auth/guards.ts'
import { ProjectsPage } from './ProjectsPage.tsx'

async function loader(): Promise<Project[]> {
  await requireAuthenticatedUser()
  return projects.all()
}

export const routes: RouteObject[] = [{ path: '/projects', loader, Component: ProjectsPage }]
