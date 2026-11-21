// Notification rotation on completed navigations (spec §4.1, AC-NOT-01, risk §11-4).
// Legacy rotated on `$routeChangeSuccess`. Here a router subscriber does it when the router is idle
// at a new location key. Subscribers run when the router commits its new state, before React renders
// the new route, so a push from RouteError's effect lands *after* the rotation and survives it.
import type { DataRouter } from 'react-router'
import { rotate } from './store.ts'

export function rotateNotificationsOn(router: Pick<DataRouter, 'state' | 'subscribe'>): () => void {
  let lastKey = router.state.location.key
  return router.subscribe((state) => {
    if (state.navigation.state !== 'idle' || state.location.key === lastKey) return
    lastKey = state.location.key
    rotate()
  })
}
