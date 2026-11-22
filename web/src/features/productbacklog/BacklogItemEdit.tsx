// Port of ProductBacklogEditCtrl + productbacklog-edit.tpl.html (AC-PBL-02/03), on useCrudForm (§4.2).
// D14 fixed: legacy onError only set `updateError`, which no template showed; save and remove errors
// now notify-current with the §5.4 keys. Legacy onSave had no success message ("TODO: missing
// message"), and the spec adds none, so save and remove just return to the list.
import type { FormEvent } from 'react'
import { useLoaderData, useNavigate } from 'react-router'
import { productBacklog } from '../../api/collections.ts'
import type { BacklogItem, Draft } from '../../api/types.ts'
import { CrudButtons } from '../../crud/CrudButtons.tsx'
import { useCrudForm } from '../../crud/useCrudForm.ts'
import { required } from '../../crud/validators.ts'
import { pushForCurrentRoute } from '../../notifications/store.ts'
import type { BacklogItemData } from './routes.tsx'

/** Spec §5.6: the "new" route's draft. Numbers start undefined, so they fail `required`. */
export function newBacklogItemDraft(projectId: string): Draft<BacklogItem> {
  return { projectId, name: '', desc: '' }
}

/** The route component for both `…/productbacklog/new` and `…/productbacklog/:itemId`. */
export function BacklogItemEditPage() {
  const { projectId, backlogItem } = useLoaderData<BacklogItemData>()
  // Keyed by document id: the form state starts from `initial` once (useCrudForm).
  return (
    <BacklogItemEdit
      key={backlogItem?.id ?? 'new'}
      projectId={projectId}
      initial={backlogItem ?? newBacklogItemDraft(projectId)}
    />
  )
}

type BacklogItemEditProps = {
  projectId: string
  initial: Draft<BacklogItem>
}

function BacklogItemEdit({ projectId, initial }: BacklogItemEditProps) {
  const navigate = useNavigate()
  const toList = () => void navigate(`/projects/${projectId}/productbacklog`)

  const form = useCrudForm<BacklogItem>({
    initial,
    validators: {
      name: [required],
      desc: [required],
      priority: [required],
      estimation: [required],
    },
    numberFields: ['priority', 'estimation'],
    save: (payload) => productBacklog.save(payload),
    remove: (doc) => productBacklog.remove(doc),
    onSave: toList,
    onRemove: toList,
    onError: (op) => pushForCurrentRoute(`crud.backlogItem.${op}.error`, 'error'),
  })
  const { values, setField } = form

  return (
    <div className="well">
      <h4>Product backlog item</h4>
      <hr />
      {/* AngularJS's form directive prevented the native submit; so does this. */}
      <form name="form" onSubmit={(event: FormEvent) => event.preventDefault()}>
        {/* Labels gained htmlFor/id, as in the login modal (Q-foundation-1, Q-projects-1). The
            priority and estimation inputs keep their legacy quirk of having no `name`. */}
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
        <label htmlFor="desc">User story</label>
        <textarea
          id="desc"
          rows={8}
          cols={10}
          className="span10"
          required
          value={values.desc ?? ''}
          onChange={(event) => setField('desc', event.target.value)}
        />
        <label htmlFor="priority">Priority</label>
        <input
          type="number"
          id="priority"
          required
          value={values.priority ?? ''}
          onChange={(event) => setField('priority', event.target.value)}
        />
        <label htmlFor="estimation">Estimation</label>
        <input
          type="number"
          id="estimation"
          required
          value={values.estimation ?? ''}
          onChange={(event) => setField('estimation', event.target.value)}
        />
        <hr />
        <CrudButtons form={form} />
      </form>
    </div>
  )
}
