// Port of ProductBacklogListCtrl + productbacklog-list.tpl.html (AC-PBL-01).
import { useLoaderData } from 'react-router'
import { useListNav } from '../../crud/useListNav.ts'
import type { BacklogListData } from './routes.tsx'

export function BacklogList() {
  const { projectId, backlog } = useLoaderData<BacklogListData>()
  const { onNew, onEdit } = useListNav(`/projects/${projectId}/productbacklog`)

  return (
    <>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Priority</th>
            <th>Estimation</th>
          </tr>
        </thead>
        <tbody>
          {backlog.map((backlogItem, index) => (
            <tr key={backlogItem.id ?? index} onClick={() => backlogItem.id !== undefined && onEdit(backlogItem.id)}>
              <td>{backlogItem.name}</td>
              <td>{backlogItem.desc}</td>
              <td>{backlogItem.priority}</td>
              <td>{backlogItem.estimation}</td>
            </tr>
          ))}
          {backlog.length === 0 && (
            <tr>
              <td colSpan={4}>No items in the backlog</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="well">
        <button className="btn" onClick={onNew}>
          New backlog item
        </button>
      </div>
    </>
  )
}
