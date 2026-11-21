// Port of legacy security/retryQueue.js: a queue of things to retry once the user has logged in.
// Each item exposes retry() and cancel(); pushRetryFn() wraps a function in a promise that settles
// with the retry's outcome, or rejects when the login is cancelled (AC-API-07, AC-AUTH-05).

export type RetryReason = 'unauthenticated-client' | 'unauthorized-client' | 'unauthorized-server'

export type RetryItem = {
  reason?: RetryReason
  retry(): void
  cancel(): void
}

/** The rejection a queued promise gets when the login dialog is cancelled. Legacy rejected with `undefined`. */
export class RetryCancelledError extends Error {
  constructor() {
    super('Login cancelled')
    this.name = 'RetryCancelledError'
  }
}

export type RetryQueue = ReturnType<typeof createRetryQueue>

export function createRetryQueue() {
  const items: RetryItem[] = []
  const onItemAddedCallbacks = new Set<(item: RetryItem) => void>()

  function shiftAll(): RetryItem[] {
    return items.splice(0, items.length)
  }

  const queue = {
    /** Legacy `onItemAddedCallbacks.push(cb)`; returns an unsubscribe function. */
    onItemAdded(callback: (item: RetryItem) => void): () => void {
      onItemAddedCallbacks.add(callback)
      return () => onItemAddedCallbacks.delete(callback)
    },

    hasMore(): boolean {
      return items.length > 0
    },

    push(item: RetryItem): void {
      items.push(item)
      for (const callback of onItemAddedCallbacks) {
        try {
          callback(item)
        } catch (error) {
          // Legacy logged and carried on, so one bad listener can't break the queue.
          console.error('retryQueue.push(item): callback threw an error', error)
        }
      }
    },

    pushRetryFn<T>(reason: RetryReason | undefined, retryFn: () => T | PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          reason,
          retry() {
            // Called synchronously, like legacy `$q.when(retryFn())`.
            try {
              Promise.resolve(retryFn()).then(resolve, reject)
            } catch (error) {
              reject(error)
            }
          },
          cancel() {
            reject(new RetryCancelledError())
          },
        })
      })
    },

    /** The first item's reason, or undefined when the queue is empty or the item has none. */
    retryReason(): RetryReason | undefined {
      return items[0]?.reason
    },

    cancelAll(): void {
      for (const item of shiftAll()) item.cancel()
    },

    retryAll(): void {
      for (const item of shiftAll()) item.retry()
    },

    /** Drops every item without settling it. Test isolation only (src/test/renderRoute.tsx). */
    reset(): void {
      shiftAll()
    },
  }
  return queue
}

/** The app's one queue. api/http.ts pushes 401s here; guards push here; the login dialog drains it. */
export const retryQueue = createRetryQueue()
