// Legacy admin-projects.spec.js, TeamMembersController: addTeamMember / removeTeamMember / usersLookup.
import { describe, expect, it } from 'vitest'
import type { User } from '../../api/types.ts'
import { addTeamMember, removeTeamMember, usersLookup } from './teamMembers.ts'

const someUser: User = { id: 'X', email: 'x@ascrum.test', firstName: 'X', lastName: 'Ex' }

describe('TeamMembersController state (teamMembers.ts)', () => {
  it('legacy :96: usersLookup maps each user id to its user', () => {
    expect(usersLookup([someUser])).toEqual(new Map([['X', someUser]]))
  })

  it('legacy :133: does not push into the team if no team member is selected', () => {
    const state = { teamMembers: [], selTeamMember: undefined }
    expect(addTeamMember(state).teamMembers).toHaveLength(0)
  })

  it('legacy :144 / AC-APR-04: pushes the selected member into the team and clears the selection', () => {
    const next = addTeamMember({ teamMembers: [], selTeamMember: 'A' })
    expect(next.teamMembers).toEqual(['A'])
    expect(next.selTeamMember).toBeUndefined()
  })

  it('legacy :163: removes the specified team member if it is in the team', () => {
    const next = removeTeamMember({ teamMembers: ['A'], selTeamMember: undefined }, 'A')
    expect(next.teamMembers).toHaveLength(0)
  })

  it('legacy :175: does not affect the team if the specified member is not in it', () => {
    const next = removeTeamMember({ teamMembers: ['A'], selTeamMember: undefined }, 'B')
    expect(next.teamMembers).toEqual(['A'])
  })

  it('AC-APR-04: removing the member that is currently selected clears the selection too', () => {
    expect(removeTeamMember({ teamMembers: ['A', 'B'], selTeamMember: 'A' }, 'A')).toEqual({
      teamMembers: ['B'],
      selTeamMember: undefined,
    })
    // Removing someone else keeps the selection.
    expect(removeTeamMember({ teamMembers: ['A', 'B'], selTeamMember: 'C' }, 'A').selTeamMember).toBe('C')
  })
})
