// The login dialog's open/closed state, from legacy security.js (openLoginDialog / closeLoginDialog /
// onLoginDialogClose). It is a module store, not React state, because guards in the router's INITIAL
// loaders push to the retry queue before React has mounted anything (spec §4.1, risk §11-4).
import { retryQueue, type RetryReason } from './retryQueue.ts'

let openId: number | null = null
let opened = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeLoginDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A number per opening (so the form starts fresh each time), or null while closed. */
export function getLoginDialogId(): number | null {
  return openId
}

/** S7: opening while already open is a no-op (legacy threw, and the error was swallowed). */
export function openLoginDialog(): void {
  if (openId !== null) return
  opened += 1
  openId = opened
  emit()
}

/**
 * Legacy onLoginDialogClose: success → retry every queued item; otherwise cancel them all.
 * Closing a closed dialog does nothing. Navigating to '/' after a cancel is the caller's job
 * (AuthProvider owns the router).
 */
export function closeLoginDialog(success: boolean): void {
  if (openId === null) return
  openId = null
  emit()
  if (success) retryQueue.retryAll()
  else retryQueue.cancelAll()
}

/** The first queued item's reason; undefined when the dialog was opened from the toolbar. */
export function getLoginReason(): RetryReason | undefined {
  return retryQueue.retryReason()
}

/** Test isolation only (src/test/renderRoute.tsx). */
export function resetLoginDialog(): void {
  openId = null
  emit()
}

// AC-AUTH-02: every push onto the retry queue opens the dialog (legacy security.js registered the
// same callback). Registered once, at module load, so it is in place before any loader runs.
retryQueue.onItemAdded(() => {
  if (retryQueue.hasMore()) openLoginDialog()
})
