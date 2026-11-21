import { useSyncExternalStore } from 'react'
import { getCurrent, subscribe, type Notification } from './store.ts'

/** The current-route notifications; re-renders on every change. */
export function useNotifications(): readonly Notification[] {
  return useSyncExternalStore(subscribe, getCurrent)
}
