// The sprint-backlog half of sprints-edit.tpl.html (AC-SPR-03/04): the sprint's items on the left, the
// project's remaining backlog on the right. It edits `sprintBacklog` through `onChange`, so every add or
// remove goes through useCrudForm and marks the form dirty.
import { useNavigate } from 'react-router'
import type { BacklogItem } from '../../api/types.ts'
import { backlogLookup, estimationInTotal, notInSprint, withBacklogItem, withoutBacklogItem } from './sprintBacklog.ts'

type SprintBacklogPickerProps = {
  projectId: string
  productBacklog: readonly BacklogItem[]
  sprintBacklog: readonly string[]
  onChange: (next: string[]) => void
}

export function SprintBacklogPicker({ projectId, productBacklog, sprintBacklog, onChange }: SprintBacklogPickerProps) {
  const navigate = useNavigate()
  const lookup = backlogLookup(productBacklog)
  // Legacy `viewProductBacklogItem(id)`.
  const viewItem = (id: string) => void navigate(`/projects/${projectId}/productbacklog/${id}`)

  return (
    <div className="row-fluid">
      {/* These two legacy labels caption tables, not form controls, so there is no control to link
          with htmlFor (P1); they stay as they were (Q-sprints-tasks-1). */}
      <div className="span6">
        <label>Currently in the sprint&apos;s backlog</label>
        <table className="table table-bordered table-condensed table-striped table-hover">
          <thead>
            <tr>
              <th className="span8">Name</th>
              <th className="span2">Estimation</th>
              <th className="span2">Tools</th>
            </tr>
          </thead>
          <tbody>
            {sprintBacklog.map((id, index) => {
              // D13: an id whose backlog item no longer exists renders as a blank row that can still be
              // removed; legacy rendered the same blank cells but its total threw.
              const item = lookup.get(id)
              return (
                <tr key={`${id}-${index}`}>
                  <td>
                    {/* Legacy markup: an anchor with ng-click and no href. */}
                    <a onClick={() => viewItem(id)}>{item?.name}</a>
                  </td>
                  <td>{item?.estimation}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-mini btn-danger"
                      onClick={() => onChange(withoutBacklogItem(sprintBacklog, id))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Estimation in total</td>
              <td>{estimationInTotal(sprintBacklog, lookup)}</td>
              <td>-</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="span6">
        <label>Product backlog</label>
        <table className="table table-bordered table-condensed table-striped table-hover">
          <thead>
            <tr>
              <th className="span8">Name</th>
              <th className="span2">Estimation</th>
              <th className="span2">Tools</th>
            </tr>
          </thead>
          <tbody>
            {notInSprint(productBacklog, sprintBacklog).map((item) => {
              const id = item.id
              if (id === undefined) return null // notInSprint only returns saved items
              return (
                <tr key={id}>
                  <td>
                    <a onClick={() => viewItem(id)}>{item.name}</a>
                  </td>
                  <td>{item.estimation}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-mini"
                      onClick={() => onChange(withBacklogItem(sprintBacklog, id))}
                    >
                      Add to sprint
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
