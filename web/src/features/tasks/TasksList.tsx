// Port of TasksListCtrl + tasks-list.tpl.html (AC-TSK-01). Only the Name cell opens the edit page, and
// the Tools column is empty, as in legacy.
import { useLoaderData } from 'react-router'
import { useListNav } from '../../crud/useListNav.ts'
import type { TasksListData } from './routes.tsx'

export function TasksList() {
  const { projectId, sprintId, tasks } = useLoaderData<TasksListData>()
  const { onNew, onEdit } = useListNav(`/projects/${projectId}/sprints/${sprintId}/tasks`)

  return (
    <>
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
              <td onClick={() => task.id !== undefined && onEdit(task.id)}>{task.name}</td>
              <td>{task.estimation}</td>
              <td>{task.remaining}</td>
              <td></td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={4}>No tasks defined for this sprint</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="well">
        <button className="btn" onClick={onNew}>
          New task
        </button>
      </div>
    </>
  )
}
