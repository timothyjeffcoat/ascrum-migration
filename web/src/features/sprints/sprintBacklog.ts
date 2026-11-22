// Pure helpers for SprintsEditCtrl's sprint-backlog picker (AC-SPR-03/04). They live with the feature,
// not in domain/, because they are screen logic (legacy kept them on the controller's scope, not on a
// resource prototype).
import type { BacklogItem } from '../../api/types.ts'

export type BacklogLookup = ReadonlyMap<string, BacklogItem>

/** Legacy `productBacklogLookup`: backlog items by id. */
export function backlogLookup(items: readonly BacklogItem[]): BacklogLookup {
  const lookup = new Map<string, BacklogItem>()
  for (const item of items) if (item.id !== undefined) lookup.set(item.id, item)
  return lookup
}

/**
 * Legacy `estimationInTotal()`. D13 fixed: legacy read `.estimation` of the lookup entry, which threw
 * for an id whose backlog item had been deleted. A missing item now counts as 0.
 */
export function estimationInTotal(sprintBacklog: readonly string[], lookup: BacklogLookup): number {
  let total = 0
  for (const id of sprintBacklog) total += lookup.get(id)?.estimation ?? 0
  return total
}

/** Legacy `notSelected` filter: the project's backlog items that are not in the sprint yet. */
export function notInSprint(items: readonly BacklogItem[], sprintBacklog: readonly string[]): BacklogItem[] {
  return items.filter((item) => item.id !== undefined && !sprintBacklog.includes(item.id))
}

/** Legacy `addBacklogItem`: appends the id. Returns a new array so the form sees a change. */
export function withBacklogItem(sprintBacklog: readonly string[], id: string): string[] {
  return [...sprintBacklog, id]
}

/** Legacy `removeBacklogItem`: splice(indexOf(id), 1), i.e. the first occurrence only. */
export function withoutBacklogItem(sprintBacklog: readonly string[], id: string): string[] {
  const index = sprintBacklog.indexOf(id)
  return index === -1 ? [...sprintBacklog] : [...sprintBacklog.slice(0, index), ...sprintBacklog.slice(index + 1)]
}
