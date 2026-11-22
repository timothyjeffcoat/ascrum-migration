// Port of the `projectsinfo` module's route (projectsinfo/projectsinfo.js, R1): `/projectsinfo`, public
// (spec §5.3), resolving all projects like the legacy `resolve`.
import type { RouteObject } from 'react-router'
import { projects } from '../../api/collections.ts'
import type { Project } from '../../api/types.ts'
import { ProjectsInfo } from './ProjectsInfo.tsx'

// D1 preserved: the projects are fetched (so a failure still shows the route-change error, as legacy's
// failed resolve did) but never displayed.
async function loader(): Promise<Project[]> {
  return projects.all()
}

export const routes: RouteObject[] = [{ path: '/projectsinfo', loader, Component: ProjectsInfo }]
