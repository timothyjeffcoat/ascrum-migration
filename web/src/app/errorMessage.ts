import { isRouteErrorResponse } from 'react-router'

/** The `{{message}}` for `error.fatal`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`.trim()
  return String(error)
}
