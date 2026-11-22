// Port of ProjectsViewCtrl (projects/projects.js) for `/projects` (R3): all projects (legacy TODO
// "fetch only for the current user" stays open, as on the dashboard, D2) with the current user's roles.
import { useLoaderData } from 'react-router'
import type { Project } from '../../api/types.ts'
import { useAuth } from '../../auth/useAuth.ts'
import { ProjectsTable } from './ProjectsTable.tsx'

export function ProjectsPage() {
  const projects = useLoaderData<Project[]>()
  const { currentUser } = useAuth()
  return <ProjectsTable projects={projects} currentUserId={currentUser?.id} />
}
