// D10 fixed: legacy mongolabResource resolved HTTP errors to `undefined`, so a failing route resolve
// still rendered its view. Here every non-2xx rejects with an ApiError (spec §6, AC-API-04).

export type ApiErrorCode = 'resource.notfound'

export class ApiError extends Error {
  /** HTTP status; 0 when the request never got a response (network failure), as AngularJS reported it. */
  readonly status: number
  /** Set for a 404 on getById, matching the legacy `{code:'resource.notfound'}` rejection. */
  readonly code: ApiErrorCode | undefined
  readonly collection: string | undefined
  /** The parsed response body, if any. */
  readonly body: unknown

  constructor(status: number, opts: { code?: ApiErrorCode; collection?: string; body?: unknown } = {}) {
    super(opts.code ? `${opts.code} (HTTP ${status})` : `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = opts.code
    this.collection = opts.collection
    this.body = opts.body
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
