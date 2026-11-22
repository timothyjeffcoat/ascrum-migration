// errorElement of the pathless layout route (spec §4.1), so errors render INSIDE the shell.
// Legacy AppCtrl turned `$routeChangeError` into a notification and kept the previous view; S5: here
// the content area is empty instead.
//   - ApiError, or a guard whose login was cancelled → notify-current `errors.route.changeError` (AC-NOT-04)
//   - anything else (a render or loader bug) → notify-current `error.fatal {message}` (AC-NOT-05; the
//     intent of the never-wired legacy exceptionHandler.js)
import { useEffect, useRef } from 'react'
import { useRouteError } from 'react-router'
import { isApiError } from '../api/errors.ts'
import { RetryCancelledError } from '../auth/retryQueue.ts'
import { pushForCurrentRoute } from '../notifications/store.ts'
import { errorMessage } from './errorMessage.ts'

export function RouteError() {
  const error = useRouteError()
  // StrictMode runs effects twice; the ref (kept across that re-run) makes it one notification per error.
  const notified = useRef<unknown>(undefined)

  useEffect(() => {
    if (notified.current === error) return
    notified.current = error
    if (isApiError(error) || error instanceof RetryCancelledError) {
      pushForCurrentRoute('errors.route.changeError', 'error')
    } else {
      pushForCurrentRoute('error.fatal', 'error', { message: errorMessage(error) })
    }
  }, [error])

  return null
}
