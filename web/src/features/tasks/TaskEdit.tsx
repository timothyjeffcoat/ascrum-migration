// Port of TasksEditCtrl + tasks-edit.tpl.html (AC-TSK-02/03), on useCrudForm (§4.2).
// D6 fixed: legacy onSave went to `/admin/users`; save and remove now return to the sprint's task list.
// D14 fixed: legacy onError only set `updateError`, which no template showed; save and remove errors
// now notify-current with the §5.4 keys. Legacy had no success message, and the spec adds none.
import type { FormEvent } from 'react'
import { useLoaderData, useNavigate } from 'react-router'
import { tasks as tasksApi } from '../../api/collections.ts'
import type { BacklogItem, Draft, Task, User } from '../../api/types.ts'
import { CrudButtons } from '../../crud/CrudButtons.tsx'
import { useCrudForm } from '../../crud/useCrudForm.ts'
import { required } from '../../crud/validators.ts'
import { TASK_STATES } from '../../domain/tasks.ts'
import { fullName } from '../../domain/users.ts'
import { pushForCurrentRoute } from '../../notifications/store.ts'
import type { TaskData } from './routes.tsx'

/** Spec §5.6: the "new" route's draft. A new task is `TODO` (legacy `Tasks.statesEnum[0]`). */
export function newTaskDraft(projectId: string, sprintId: string): Draft<Task> {
  return { projectId, sprintId, name: '', desc: '', state: 'TODO' }
}

/** The route component for both `…/tasks/new` and `…/tasks/:itemId`. */
export function TaskEditPage() {
  const { projectId, sprintId, task, sprintBacklogItems, teamMembers } = useLoaderData<TaskData>()
  // Keyed by document id: the form state starts from `initial` once (useCrudForm).
  return (
    <TaskEdit
      key={task?.id ?? 'new'}
      projectId={projectId}
      sprintId={sprintId}
      initial={task ?? newTaskDraft(projectId, sprintId)}
      sprintBacklogItems={sprintBacklogItems}
      teamMembers={teamMembers}
    />
  )
}

type TaskEditProps = {
  projectId: string
  sprintId: string
  initial: Draft<Task>
  sprintBacklogItems: readonly BacklogItem[]
  teamMembers: readonly User[]
}

/** A select's blank option is '' in the DOM and `undefined` in the form (S13; §5.6 selects). */
const fromSelect = (value: string): string | undefined => (value === '' ? undefined : value)

function TaskEdit({ projectId, sprintId, initial, sprintBacklogItems, teamMembers }: TaskEditProps) {
  const navigate = useNavigate()
  // D6: back to this sprint's tasks (legacy went to /admin/users).
  const toList = () => void navigate(`/projects/${projectId}/sprints/${sprintId}/tasks`)

  const form = useCrudForm<Task>({
    initial,
    validators: {
      name: [required],
      productBacklogItemId: [required],
      desc: [required],
      estimation: [required],
      remaining: [required],
      state: [required],
    },
    numberFields: ['estimation', 'remaining'],
    save: (payload) => tasksApi.save(payload),
    remove: (doc) => tasksApi.remove(doc),
    onSave: toList,
    onRemove: toList,
    onError: (op) => pushForCurrentRoute(`crud.task.${op}.error`, 'error'),
  })
  const { values, setField } = form

  return (
    // P4: the form never submits natively (Enter must not reload the page and lose edits).
    <form name="form" onSubmit={(event: FormEvent) => event.preventDefault()}>
      <div className="well">
        <div className="row-fluid">
          {/* P1: labels gained htmlFor and controls an id (the model field). The legacy quirks stay: the
              backlog select is named "productBacklog", the description has no name, and both the State
              and Assigned to selects are named "state". */}
          <div className="span6">
            <label htmlFor="name">Name</label>
            <input
              type="text"
              id="name"
              name="name"
              className="span10"
              required
              autoFocus
              value={values.name ?? ''}
              onChange={(event) => setField('name', event.target.value)}
            />
            <label htmlFor="productBacklogItemId">Product Backlog item</label>
            <select
              id="productBacklogItemId"
              name="productBacklog"
              className="span10"
              required
              value={values.productBacklogItemId ?? ''}
              onChange={(event) => setField('productBacklogItemId', fromSelect(event.target.value))}
            >
              {/* S13: an explicit blank option for a controlled select. */}
              <option value="">-- choose --</option>
              {sprintBacklogItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <label htmlFor="desc">Description</label>
            <textarea
              id="desc"
              rows={8}
              cols={10}
              className="span10"
              required
              value={values.desc ?? ''}
              onChange={(event) => setField('desc', event.target.value)}
            />
          </div>
          <div className="span6">
            <label htmlFor="estimation">Estimation</label>
            <input
              type="number"
              id="estimation"
              name="estimation"
              className="span5"
              required
              value={values.estimation ?? ''}
              onChange={(event) => setField('estimation', event.target.value)}
            />
            <label htmlFor="remaining">Remaining</label>
            <input
              type="number"
              id="remaining"
              name="remaining"
              className="span5"
              required
              value={values.remaining ?? ''}
              onChange={(event) => setField('remaining', event.target.value)}
            />
            <label htmlFor="state">State</label>
            {/* Every route starts with a state (the draft's TODO or the loaded one), so, as in legacy,
                there is no blank option. */}
            <select
              id="state"
              name="state"
              className="span5"
              required
              value={values.state ?? ''}
              onChange={(event) => setField('state', fromSelect(event.target.value))}
            >
              {TASK_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
            <label htmlFor="assignedUserId">Assigned to</label>
            <select
              id="assignedUserId"
              name="state"
              className="span10"
              value={values.assignedUserId ?? ''}
              onChange={(event) => setField('assignedUserId', fromSelect(event.target.value))}
            >
              {/* S13: legacy could not unassign once set; the blank option removes assignedUserId. */}
              <option value="">-- unassigned --</option>
              {teamMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {fullName(member)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <hr />
        <CrudButtons form={form} />
      </div>
    </form>
  )
}
