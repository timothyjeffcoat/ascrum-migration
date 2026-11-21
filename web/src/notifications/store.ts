// Port of services/notifications.js + services/i18nNotifications.js as one external store
// (read with useSyncExternalStore). Two buckets: current-route and next-route (AC-NOT-01).
// S15: the sticky bucket is dropped, since `pushSticky` had no live caller (A2).
import { getMessage, type MessageParams } from './messages.ts'

export type NotificationType = 'success' | 'error' | 'info' | 'warning'

export type Notification = {
  readonly id: number
  readonly type: NotificationType
  readonly message: string
}

// Arrays are replaced, never mutated, so a snapshot read by React stays stable until a change.
let current: readonly Notification[] = []
let next: readonly Notification[] = []
let lastId = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function create(key: string, type: NotificationType, params?: MessageParams): Notification {
  lastId += 1
  return { id: lastId, type, message: getMessage(key, params) }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The notifications to show now (legacy `getCurrent`, minus the dropped sticky bucket). */
export function getCurrent(): readonly Notification[] {
  return current
}

/** Shown now; gone after the next completed navigation ("notify-current"). */
export function pushForCurrentRoute(key: string, type: NotificationType, params?: MessageParams): Notification {
  const notification = create(key, type, params)
  current = [...current, notification]
  emit()
  return notification
}

/** Shown after the next completed navigation, then gone after the one after ("notify-next"). */
export function pushForNextRoute(key: string, type: NotificationType, params?: MessageParams): Notification {
  const notification = create(key, type, params)
  next = [...next, notification]
  emit()
  return notification
}

/** Removing a notification that is not there is a no-op (legacy). */
export function remove(notification: Notification): void {
  const keep = (n: Notification) => n !== notification
  if (current.includes(notification)) current = current.filter(keep)
  if (next.includes(notification)) next = next.filter(keep)
  emit()
}

export function removeAll(): void {
  current = []
  next = []
  emit()
}

/** Legacy `$routeChangeSuccess`: current := next, next := []. Called by rotation.ts. */
export function rotate(): void {
  current = next
  next = []
  emit()
}
