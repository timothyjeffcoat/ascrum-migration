// Port of ProjectsEditCtrl + admin/projects/projects-edit.tpl.html (AC-APR-02..06). The right-hand
// column (PO, SM, development team) is <TeamMembers>, legacy's TeamMembersController.
import { useNavigate } from 'react-router'
import { projects as projectsApi } from '../../api/collections.ts'
import type { Draft, Project, User } from '../../api/types.ts'
import { CrudButtons } from '../../crud/CrudButtons.tsx'
import { useCrudForm } from '../../crud/useCrudForm.ts'
import { required } from '../../crud/validators.ts'
import { pushForCurrentRoute, pushForNextRoute } from '../../notifications/store.ts'
import { TeamMembers } from './TeamMembers.tsx'
import type { ProjectExtra } from './teamMembers.ts'

/** §5.6 draft for `/admin/projects/new`. */
export function newProjectDraft(): Draft<Project> {
  return { name: '', desc: '', teamMembers: [] }
}

/** §5.6 / D13: a loaded project without `teamMembers` gets [] inside the form only (never in api/). */
export function projectFormInitial(project: Project): Draft<Project> {
  return { ...project, teamMembers: project.teamMembers ?? [] }
}

type ProjectEditProps = {
  initial: Draft<Project>
  users: readonly User[]
}

export function ProjectEdit({ initial, users }: ProjectEditProps) {
  const navigate = useNavigate()
  const form = useCrudForm<Project, ProjectExtra>({
    initial,
    extra: { selTeamMember: undefined },
    // AC-APR-02/03: name, Product Owner and Scrum Master are `required`; the description is optional.
    validators: { name: [required], productOwner: [required], scrumMaster: [required] },
    save: (payload) => projectsApi.save(payload),
    remove: (doc) => projectsApi.remove(doc),
    onSave: (saved) => {
      pushForNextRoute('crud.project.save.success', 'success', { id: saved.id })
      void navigate('/admin/projects')
    },
    // D21 / S4: legacy had no onRemove, so crudEdit fell back to onSave and said "saved".
    onRemove: (doc) => {
      pushForNextRoute('crud.project.remove.success', 'success', { id: doc.id })
      void navigate('/admin/projects')
    },
    // S12: a failed remove has its own message; legacy reused the save wording.
    onError: (op) => {
      if (op === 'save') pushForCurrentRoute('crud.project.save.error', 'error')
      else pushForCurrentRoute('crud.project.remove.error', 'error', { id: form.values.id })
    },
  })
  const { values } = form

  return (
    <div className="well">
      <form name="form">
        <legend>Project</legend>
        <div className="row-fluid">
          <div className="span6">
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              type="text"
              name="name"
              value={values.name ?? ''}
              onChange={(event) => form.setField('name', event.target.value)}
              className="span10"
              required
              autoFocus
            />
            <label htmlFor="project-desc">Description</label>
            <textarea
              id="project-desc"
              rows={10}
              cols={10}
              value={values.desc ?? ''}
              onChange={(event) => form.setField('desc', event.target.value)}
              className="span10"
            />
          </div>
          <TeamMembers form={form} users={users} />
        </div>
        <div className="row-fluid">
          <hr />
          <div className="span12">
            <CrudButtons form={form} />
          </div>
        </div>
      </form>
    </div>
  )
}
