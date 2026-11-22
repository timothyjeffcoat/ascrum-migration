// Port of SprintsListCtrl + sprints-list.tpl.html (AC-SPR-01). D12 preserved: the Status column is the
// literal "ACTIVE" (legacy never stored a status).
import { useLoaderData, useNavigate } from 'react-router'
import type { Sprint } from '../../api/types.ts'
import { useListNav } from '../../crud/useListNav.ts'
import type { SprintsListData } from './routes.tsx'

export function SprintsList() {
  const { projectId, sprints } = useLoaderData<SprintsListData>()
  const prefix = `/projects/${projectId}/sprints`
  const { onNew, onEdit } = useListNav(prefix)
  const navigate = useNavigate()

  const edit = (sprint: Sprint) => {
    if (sprint.id !== undefined) onEdit(sprint.id)
  }
  // Legacy `$scope.tasks(sprint)`.
  const tasks = (sprint: Sprint) => {
    if (sprint.id !== undefined) void navigate(`${prefix}/${sprint.id}/tasks`)
  }

  return (
    <>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th>Name</th>
            <th>Start date</th>
            <th>End date</th>
            <th>Status</th>
            <th>Tools</th>
          </tr>
        </thead>
        <tbody>
          {sprints.map((sprint, index) => (
            <tr key={sprint.id ?? index}>
              <td onClick={() => edit(sprint)}>{sprint.name}</td>
              <td onClick={() => edit(sprint)}>{sprint.start}</td>
              <td onClick={() => edit(sprint)}>{sprint.end}</td>
              <td onClick={() => edit(sprint)}>ACTIVE</td>
              <td>
                <button type="button" className="btn btn-mini" onClick={() => tasks(sprint)}>
                  Tasks
                </button>
              </td>
            </tr>
          ))}
          {sprints.length === 0 && (
            <tr>
              <td colSpan={5}>No sprints defined</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="well">
        <button className="btn" onClick={onNew}>
          New sprint
        </button>
      </div>
    </>
  )
}
