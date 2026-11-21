// Port of the Projects resource prototype (common/resources/projects.js) and the candidate filters of
// admin-projects.js TeamMembersController/ProjectsEditCtrl, as pure functions (spec §4, AC-DOM-01/02/05).
// D13 fixed: legacy isDevTeamMember threw when `teamMembers` was missing; it now counts as [].
import type { Draft, Project, User } from '../api/types.ts'

export type ProjectRoles = Pick<Draft<Project>, 'productOwner' | 'scrumMaster' | 'teamMembers'>
export type Role = 'PO' | 'SM' | 'DEV'

export function isProductOwner(project: ProjectRoles, userId: string): boolean {
  return project.productOwner === userId
}

export function canActAsProductOwner(project: ProjectRoles, userId: string): boolean {
  return !isScrumMaster(project, userId) && !isDevTeamMember(project, userId)
}

export function isScrumMaster(project: ProjectRoles, userId: string): boolean {
  return project.scrumMaster === userId
}

export function canActAsScrumMaster(project: ProjectRoles, userId: string): boolean {
  return !isProductOwner(project, userId)
}

export function isDevTeamMember(project: ProjectRoles, userId: string): boolean {
  return (project.teamMembers ?? []).includes(userId)
}

export function canActAsDevTeamMember(project: ProjectRoles, userId: string): boolean {
  return !isProductOwner(project, userId)
}

/** PO is exclusive; otherwise SM and/or DEV, in that order (AC-DOM-02). */
export function getRoles(project: ProjectRoles, userId: string): Role[] {
  if (isProductOwner(project, userId)) return ['PO']
  const roles: Role[] = []
  if (isScrumMaster(project, userId)) roles.push('SM')
  if (isDevTeamMember(project, userId)) roles.push('DEV')
  return roles
}

/** D20 fixed: legacy rendered the raw array (`["PO"]`); now `PO`, `SM, DEV`, or ''. */
export function formatRoles(roles: readonly Role[]): string {
  return roles.join(', ')
}

// Legacy also required `usersLookup[user.$id()]`, which holds for every user with an id.
export function productOwnerCandidates(users: readonly User[], project: ProjectRoles): User[] {
  return users.filter((user) => user.id !== undefined && canActAsProductOwner(project, user.id))
}

export function scrumMasterCandidates(users: readonly User[], project: ProjectRoles): User[] {
  return users.filter((user) => user.id !== undefined && canActAsScrumMaster(project, user.id))
}

/** Can be a developer and is not one already (AC-DOM-05). */
export function teamMemberCandidates(users: readonly User[], project: ProjectRoles): User[] {
  return users.filter(
    (user) => user.id !== undefined && canActAsDevTeamMember(project, user.id) && !isDevTeamMember(project, user.id),
  )
}
