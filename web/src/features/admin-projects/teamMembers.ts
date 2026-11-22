// The state changes of legacy admin-projects.js TeamMembersController (addTeamMember, removeTeamMember,
// usersLookup), as pure functions over the form's `teamMembers` value and `extra.selTeamMember`.
// The candidate filters are not here: they come from domain/projects.ts (AC-DOM-05).
import type { User } from '../../api/types.ts'

/** The form-only fields of the project form (spec §5.6): never saved, never dirty. */
export type ProjectExtra = { selTeamMember: string | undefined }

export type TeamState = { teamMembers: readonly string[]; selTeamMember: string | undefined }

/** Legacy `usersLookup`: user id → user, to name the rows of the team table. */
export function usersLookup(users: readonly User[]): Map<string, User> {
  const lookup = new Map<string, User>()
  for (const user of users) if (user.id !== undefined) lookup.set(user.id, user)
  return lookup
}

/** Adds the selected user, then clears the selection. Nothing selected: nothing changes. */
export function addTeamMember(state: TeamState): TeamState {
  if (!state.selTeamMember) return state
  return { teamMembers: [...state.teamMembers, state.selTeamMember], selTeamMember: undefined }
}

/** Removes `member` if present; if it is the selected user, the selection is cleared too (AC-APR-04). */
export function removeTeamMember(state: TeamState, member: string): TeamState {
  const idx = state.teamMembers.indexOf(member)
  const teamMembers = idx >= 0 ? state.teamMembers.filter((_, i) => i !== idx) : state.teamMembers
  const selTeamMember = state.selTeamMember === member ? undefined : state.selTeamMember
  return { teamMembers, selTeamMember }
}
