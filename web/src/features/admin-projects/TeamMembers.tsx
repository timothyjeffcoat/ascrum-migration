// Port of TeamMembersController and the `span6` column of admin/projects/projects-edit.tpl.html it
// controlled: the Product Owner and Scrum Master selects and the Development Team table.
// The candidate lists come from domain/ (AC-DOM-05) and are recomputed on every render from the
// form's current values, so they follow PO/SM/team changes (AC-APR-05), as legacy's scope functions did.
import type { Project, User } from '../../api/types.ts'
import type { CrudForm } from '../../crud/useCrudForm.ts'
import { productOwnerCandidates, scrumMasterCandidates, teamMemberCandidates } from '../../domain/projects.ts'
import { fullName } from '../../domain/users.ts'
import { addTeamMember, removeTeamMember, usersLookup, type ProjectExtra, type TeamState } from './teamMembers.ts'

type TeamMembersProps = {
  form: CrudForm<Project, ProjectExtra>
  users: readonly User[]
}

/** A select's '' is the blank `-- choose --` option, which leaves the field unset (S13). */
function fromSelect(value: string): string | undefined {
  return value === '' ? undefined : value
}

export function TeamMembers({ form, users }: TeamMembersProps) {
  const { values, extra } = form
  // §5.6: the form's initial value always has the array (D13: a missing one starts as []).
  const teamMembers = values.teamMembers ?? []
  const lookup = usersLookup(users)

  function setTeam(next: TeamState) {
    if (next.teamMembers !== teamMembers) form.setField('teamMembers', [...next.teamMembers])
    if (next.selTeamMember !== extra.selTeamMember) form.setExtra('selTeamMember', next.selTeamMember)
  }

  // Q-admin-projects-1 (owner answer (b)), a deliberate difference from legacy: TeamMembersController
  // kept a team pick that had stopped being a candidate (e.g. that user was just made Product Owner), so
  // `Add` stayed enabled and could add the PO as a developer. Choosing a PO or SM now clears a pick that
  // is no longer in teamMemberCandidates for the new values. Done in the change handler, not an effect.
  function setRole(field: 'productOwner' | 'scrumMaster', value: string | undefined) {
    form.setField(field, value)
    const picked = extra.selTeamMember
    if (picked === undefined) return
    const stillCandidate = teamMemberCandidates(users, { ...values, [field]: value }).some((u) => u.id === picked)
    if (!stillCandidate) form.setExtra('selTeamMember', undefined)
  }

  return (
    <div className="span6">
      <label htmlFor="project-productOwner">Product Owner</label>
      <select
        id="project-productOwner"
        className="span12"
        value={values.productOwner ?? ''}
        onChange={(event) => setRole('productOwner', fromSelect(event.target.value))}
        required
      >
        <option value="">-- choose --</option>
        {productOwnerCandidates(users, values).map((user) => (
          <option key={user.id} value={user.id}>
            {fullName(user)}
          </option>
        ))}
      </select>
      <label htmlFor="project-scrumMaster">Scrum Master</label>
      <select
        id="project-scrumMaster"
        className="span12"
        value={values.scrumMaster ?? ''}
        onChange={(event) => setRole('scrumMaster', fromSelect(event.target.value))}
        required
      >
        <option value="">-- choose --</option>
        {scrumMasterCandidates(users, values).map((user) => (
          <option key={user.id} value={user.id}>
            {fullName(user)}
          </option>
        ))}
      </select>
      <label>Development Team</label>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th>User</th>
            <th>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {teamMembers.map((userId, index) => {
            // Legacy `usersLookup[userId].getFullName()` rendered nothing for an id with no user.
            const member = lookup.get(userId)
            return (
              <tr key={`${index}-${userId}`}>
                <td>{member ? fullName(member) : ''}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() =>
                      setTeam(removeTeamMember({ teamMembers, selTeamMember: extra.selTeamMember }, userId))
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            )
          })}
          <tr>
            <td>
              <select
                className="span6"
                value={extra.selTeamMember ?? ''}
                onChange={(event) => form.setExtra('selTeamMember', fromSelect(event.target.value))}
              >
                {/* S13: a controlled select needs an explicit blank option (legacy: Angular's implicit one). */}
                <option value="">-- choose --</option>
                {teamMemberCandidates(users, values).map((user) => (
                  <option key={user.id} value={user.id}>
                    {fullName(user)}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setTeam(addTeamMember({ teamMembers, selTeamMember: extra.selTeamMember }))}
                disabled={!extra.selTeamMember}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
