// PLACEHOLDER from cluster 0 (spec §8.1): the route is final (R1, public); cluster 5 adds the loader
// and replaces the component.
import type { RouteObject } from 'react-router'

function ProjectsInfoPlaceholder() {
  return <p>Projects info: converted by cluster 5.</p>
}

export const routes: RouteObject[] = [{ path: '/projectsinfo', Component: ProjectsInfoPlaceholder }]
