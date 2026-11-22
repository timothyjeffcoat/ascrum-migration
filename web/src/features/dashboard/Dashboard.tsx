// Port of DashboardCtrl + dashboard/dashboard.tpl.html (R2).
// D3 fixed: legacy `ng-include`d projects-list.tpl.html, whose `getMyRoles` DashboardCtrl never defined
// (empty roles) and whose `manageBacklog(project)` / `manageSprints(project)` received the project
// object where DashboardCtrl expected an id (`/projects/[object Object]/…`). Reusing cluster 3's
// ProjectsTable with the current user's id gives the same roles and working links as `/projects`.
import { useLoaderData } from 'react-router'
import type { Project, Task } from '../../api/types.ts'
import { useAuth } from '../../auth/useAuth.ts'
import { ProjectsTable } from '../projects/ProjectsTable.tsx'

export type DashboardData = { projects: Project[]; tasks: Task[] }

export function Dashboard() {
  const { projects, tasks } = useLoaderData<DashboardData>()
  const { currentUser } = useAuth()

  return (
    <>
      <h4>My projects</h4>
      {/* The wrapper is the element legacy's ng-include rendered into. */}
      <div>
        <ProjectsTable projects={projects} currentUserId={currentUser?.id} />
      </div>

      <h4>My tasks</h4>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th className="span8">Name</th>
            <th className="span1">Estimation</th>
            <th className="span1">Remaining</th>
            <th className="span2">Tools</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, index) => (
            <tr key={task.id ?? index}>
              <td>{task.name}</td>
              <td>{task.estimation}</td>
              <td>{task.remaining}</td>
              <td></td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={4}>No tasks for you!</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}
