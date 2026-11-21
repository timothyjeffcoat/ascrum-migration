import { describe, expect, it } from 'vitest'
import type { Project, User } from '../api/types.ts'
import {
  canActAsDevTeamMember,
  canActAsProductOwner,
  canActAsScrumMaster,
  formatRoles,
  getRoles,
  isDevTeamMember,
  isProductOwner,
  isScrumMaster,
  productOwnerCandidates,
  scrumMasterCandidates,
  teamMemberCandidates,
} from './projects.ts'

const project: Project = { name: 'P', productOwner: 'po', scrumMaster: 'sm', teamMembers: ['dev', 'sm'] }
const user = (id: string): User => ({ id, email: `${id}@x.test`, firstName: id, lastName: id })
const users = ['po', 'sm', 'dev', 'other'].map(user)
const ids = (list: User[]) => list.map((u) => u.id)

describe('domain/projects', () => {
  it('AC-DOM-01: canActAs* and is* follow the legacy Projects prototype', () => {
    expect(isProductOwner(project, 'po')).toBe(true)
    expect(isScrumMaster(project, 'sm')).toBe(true)
    expect(isDevTeamMember(project, 'dev')).toBe(true)
    expect(isDevTeamMember(project, 'po')).toBe(false)

    // PO: neither SM nor dev. SM and dev: anyone but the PO.
    expect(canActAsProductOwner(project, 'other')).toBe(true)
    expect(canActAsProductOwner(project, 'sm')).toBe(false)
    expect(canActAsProductOwner(project, 'dev')).toBe(false)
    expect(canActAsScrumMaster(project, 'dev')).toBe(true)
    expect(canActAsScrumMaster(project, 'po')).toBe(false)
    expect(canActAsDevTeamMember(project, 'sm')).toBe(true)
    expect(canActAsDevTeamMember(project, 'po')).toBe(false)
  })

  it('AC-DOM-01 / D13: a missing teamMembers is treated as [] instead of throwing', () => {
    const partial: Project = { name: 'Legacy Cleanup', productOwner: 'po' }
    expect(isDevTeamMember(partial, 'dev')).toBe(false)
    expect(canActAsProductOwner(partial, 'dev')).toBe(true)
    expect(getRoles(partial, 'dev')).toEqual([])
    expect(ids(teamMemberCandidates(users, partial))).toEqual(['sm', 'dev', 'other'])
  })

  it('AC-DOM-02 / D20: getRoles — PO is exclusive, otherwise SM then DEV; formatRoles joins with ", "', () => {
    expect(getRoles({ ...project, teamMembers: ['po'] }, 'po')).toEqual(['PO'])
    expect(getRoles(project, 'sm')).toEqual(['SM', 'DEV'])
    expect(getRoles(project, 'dev')).toEqual(['DEV'])
    expect(getRoles(project, 'other')).toEqual([])

    expect(formatRoles(getRoles(project, 'po'))).toBe('PO')
    expect(formatRoles(getRoles(project, 'sm'))).toBe('SM, DEV')
    expect(formatRoles(getRoles(project, 'other'))).toBe('')
  })

  it('AC-DOM-05: candidates match legacy admin-projects.js:63-79, including "not already a member"', () => {
    expect(ids(productOwnerCandidates(users, project))).toEqual(['po', 'other'])
    expect(ids(scrumMasterCandidates(users, project))).toEqual(['sm', 'dev', 'other'])
    expect(ids(teamMemberCandidates(users, project))).toEqual(['other'])
    // A user without an id (never saved) is never a candidate.
    expect(productOwnerCandidates([{ email: 'x', firstName: 'x', lastName: 'x' }], project)).toEqual([])
  })
})
