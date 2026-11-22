import type { TaskState } from '../api/types.ts'

/** Legacy `Tasks.statesEnum`, in order (AC-DOM-04). */
export const TASK_STATES: readonly TaskState[] = ['TODO', 'IN_DEV', 'BLOCKED', 'IN_TEST', 'DONE']
