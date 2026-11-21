import { describe, expect, it } from 'vitest'
import { TASK_STATES } from './tasks.ts'
import { fullName } from './users.ts'

describe('domain/users and domain/tasks', () => {
  it('AC-DOM-03: fullName = "Last First (email)"', () => {
    expect(fullName({ firstName: 'Paula', lastName: 'Owner', email: 'po@ascrum.test' })).toBe(
      'Owner Paula (po@ascrum.test)',
    )
  })

  it('AC-DOM-04: TASK_STATES = TODO, IN_DEV, BLOCKED, IN_TEST, DONE', () => {
    expect(TASK_STATES).toEqual(['TODO', 'IN_DEV', 'BLOCKED', 'IN_TEST', 'DONE'])
  })
})
