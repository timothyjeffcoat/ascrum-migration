import { describe, expect, it } from 'vitest'
import type { BacklogItem } from '../../api/types.ts'
import { backlogLookup, estimationInTotal, notInSprint, withBacklogItem, withoutBacklogItem } from './sprintBacklog.ts'

const item = (id: string, estimation: number): BacklogItem => ({
  id,
  projectId: 'p',
  name: `item ${id}`,
  desc: '',
  priority: 1,
  estimation,
})
const items = [item('a', 5), item('b', 8), item('c', 13)]

describe('sprint backlog helpers (SprintsEditCtrl)', () => {
  it('AC-SPR-03: estimationInTotal sums the estimations of the sprint items', () => {
    expect(estimationInTotal(['a', 'c'], backlogLookup(items))).toBe(18)
    expect(estimationInTotal([], backlogLookup(items))).toBe(0)
  })

  it('AC-SPR-04 / D13: an id with no backlog item counts as 0 instead of throwing', () => {
    expect(estimationInTotal(['a', 'deleted', 'b'], backlogLookup(items))).toBe(13)
  })

  it('AC-SPR-03: notInSprint keeps the backlog order and drops the selected items', () => {
    expect(notInSprint(items, ['b']).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('AC-SPR-03: add appends; remove drops the first occurrence (legacy splice(indexOf))', () => {
    const start = ['a', 'b']
    expect(withBacklogItem(start, 'c')).toEqual(['a', 'b', 'c'])
    expect(withoutBacklogItem(['a', 'b', 'a'], 'a')).toEqual(['b', 'a'])
    expect(withoutBacklogItem(start, 'zzz')).toEqual(['a', 'b'])
    expect(start).toEqual(['a', 'b']) // never mutated: the form must see a new array
  })
})
