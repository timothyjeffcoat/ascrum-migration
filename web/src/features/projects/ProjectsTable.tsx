// Port of projects/projects-list.tpl.html plus ProjectsViewCtrl's manageBacklog/manageSprints/getMyRoles
// (spec §5.2). Legacy reused this template on the dashboard with `ng-include` (§4); here it is a
// component that the dashboard (cluster 5) imports, so the links and roles work there too (D3).
// D5: `viewProject` had no route and no caller in the template, so it is not ported.
import { useNavigate } from 'react-router'
import type { Project } from '../../api/types.ts'
import { formatRoles, getRoles } from '../../domain/projects.ts'

type ProjectsTableProps = {
  projects: readonly Project[]
  /** The signed-in user's id; without it the "My Role(s)" cell is empty (AC-PRJ-02, legacy getMyRoles). */
  currentUserId?: string | undefined
}

export function ProjectsTable({ projects, currentUserId }: ProjectsTableProps) {
  const navigate = useNavigate()

  function manageBacklog(project: Project) {
    if (project.id !== undefined) void navigate(`/projects/${project.id}/productbacklog`)
  }

  function manageSprints(project: Project) {
    if (project.id !== undefined) void navigate(`/projects/${project.id}/sprints`)
  }

  // D20: legacy printed the raw array (`["PO"]`); formatRoles gives `PO`, `SM, DEV` or ''.
  const myRoles = (project: Project) =>
    currentUserId === undefined ? '' : formatRoles(getRoles(project, currentUserId))

  return (
    <table className="table table-bordered table-condensed table-striped table-hover">
      <thead>
        <tr>
          <th className="span3">Name</th>
          <th className="span5">Description</th>
          <th className="span2">My Role(s)</th>
          <th className="span2">Tools</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project, index) => (
          <tr key={project.id ?? index}>
            <td onClick={() => manageBacklog(project)}>{project.name}</td>
            <td onClick={() => manageBacklog(project)}>{project.desc}</td>
            <td>{myRoles(project)}</td>
            <td>
              {/* Legacy markup: anchors with ng-click and no href. */}
              <a onClick={() => manageBacklog(project)}>Product backlog</a>{' '}
              <a onClick={() => manageSprints(project)}>Sprints</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
