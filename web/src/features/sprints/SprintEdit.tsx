// Port of SprintsEditCtrl + sprints-edit.tpl.html (AC-SPR-02..05), on useCrudForm (§4.2). The
// sprint-backlog section is <SprintBacklogPicker>.
// D12 preserved: start and end are unvalidated free text and capacity is stored but never used.
// D14 fixed: legacy onError only set `updateError`, which no template showed; save and remove errors
// now notify-current with the §5.4 keys. Legacy onSave had no success message and remove fell back to
// onSave (crudEdit), so both just return to the sprints list.
import type { FormEvent } from 'react'
import { useLoaderData, useNavigate } from 'react-router'
import { sprints as sprintsApi } from '../../api/collections.ts'
import type { BacklogItem, Draft, Sprint } from '../../api/types.ts'
import { CrudButtons } from '../../crud/CrudButtons.tsx'
import { useCrudForm } from '../../crud/useCrudForm.ts'
import { required } from '../../crud/validators.ts'
import { pushForCurrentRoute } from '../../notifications/store.ts'
import type { SprintData } from './routes.tsx'
import { SprintBacklogPicker } from './SprintBacklogPicker.tsx'

/** Spec §5.6: the "new" route's draft. Capacity starts undefined, so it fails `required`. */
export function newSprintDraft(projectId: string): Draft<Sprint> {
  return { projectId, name: '', start: '', end: '', sprintBacklog: [] }
}

/** §5.6: a loaded sprint without `sprintBacklog` gets [] inside the form only (never in api/). */
export function sprintFormInitial(sprint: Sprint): Draft<Sprint> {
  return { ...sprint, sprintBacklog: sprint.sprintBacklog ?? [] }
}

/** The route component for both `…/sprints/new` and `…/sprints/:itemId`. */
export function SprintEditPage() {
  const { projectId, sprint, productBacklog } = useLoaderData<SprintData>()
  // Keyed by document id: the form state starts from `initial` once (useCrudForm).
  return (
    <SprintEdit
      key={sprint?.id ?? 'new'}
      projectId={projectId}
      initial={sprint ? sprintFormInitial(sprint) : newSprintDraft(projectId)}
      productBacklog={productBacklog}
    />
  )
}

type SprintEditProps = {
  projectId: string
  initial: Draft<Sprint>
  productBacklog: readonly BacklogItem[]
}

function SprintEdit({ projectId, initial, productBacklog }: SprintEditProps) {
  const navigate = useNavigate()
  const toList = () => void navigate(`/projects/${projectId}/sprints`)

  const form = useCrudForm<Sprint>({
    initial,
    validators: {
      name: [required],
      capacity: [required],
      start: [required],
      end: [required],
    },
    numberFields: ['capacity'],
    save: (payload) => sprintsApi.save(payload),
    remove: (doc) => sprintsApi.remove(doc),
    onSave: toList,
    onRemove: toList,
    onError: (op) => pushForCurrentRoute(`crud.sprint.${op}.error`, 'error'),
  })
  const { values, setField } = form

  return (
    <div className="well">
      <h4>Sprint</h4>
      <hr />
      {/* P4: the form never submits natively (Enter must not reload the page and lose edits). */}
      <form name="form" onSubmit={(event: FormEvent) => event.preventDefault()}>
        <div className="row-fluid">
          {/* P1: labels gained htmlFor and controls an id (the model field). The legacy quirks stay:
              three inputs share name="name", and the capacity input is named "description". */}
          <div className="span6">
            <label htmlFor="name">Name</label>
            <input
              type="text"
              id="name"
              name="name"
              className="span10"
              required
              autoFocus
              value={form.viewValue('name')}
              onChange={(event) => setField('name', event.target.value)}
            />
            <label htmlFor="capacity">Capacity</label>
            <input
              type="number"
              id="capacity"
              name="description"
              className="span5"
              required
              value={values.capacity ?? ''}
              onChange={(event) => setField('capacity', event.target.value)}
            />
          </div>
          <div className="span6">
            <label htmlFor="start">Start date</label>
            <input
              type="text"
              id="start"
              name="name"
              className="span5"
              required
              value={form.viewValue('start')}
              onChange={(event) => setField('start', event.target.value)}
            />
            <label htmlFor="end">End date</label>
            <input
              type="text"
              id="end"
              name="name"
              className="span5"
              required
              value={form.viewValue('end')}
              onChange={(event) => setField('end', event.target.value)}
            />
          </div>
        </div>
        <hr />
        <h4>Sprint backlog</h4>
        <hr />
        <SprintBacklogPicker
          projectId={projectId}
          productBacklog={productBacklog}
          sprintBacklog={values.sprintBacklog ?? []}
          onChange={(next) => setField('sprintBacklog', next)}
        />
        <hr />
        <div>
          <CrudButtons form={form} />
        </div>
      </form>
    </div>
  )
}
