// Legacy common/security/retry-queue.spec.js, against a fresh queue per test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRetryQueue, RetryCancelledError, type RetryQueue } from './retryQueue.ts'

let queue: RetryQueue

function mockRetryItem() {
  return { retry: vi.fn(), cancel: vi.fn() }
}

beforeEach(() => {
  queue = createRetryQueue()
})

describe('legacy securityRetryQueue cases', () => {
  describe('hasMore', () => {
    it('initially has no items to retry', () => {
      expect(queue.hasMore()).toBe(false)
    })

    it('has more items once one has been pushed', () => {
      queue.push(mockRetryItem())
      expect(queue.hasMore()).toBe(true)
    })
  })

  describe('pushRetryFn', () => {
    it('adds a new item to the queue', () => {
      void queue.pushRetryFn(undefined, () => undefined)
      expect(queue.hasMore()).toBe(true)
    })

    it('adds a reason to the retry', () => {
      void queue.pushRetryFn('unauthorized-server', () => undefined)
      expect(queue.retryReason()).toBe('unauthorized-server')
    })

    it('does not add a reason to the retry if not specified', () => {
      void queue.pushRetryFn(undefined, () => undefined)
      expect(queue.retryReason()).toBeUndefined()
    })
  })

  describe('retryAll', () => {
    it('should not fail if the queue is empty', () => {
      expect(() => queue.retryAll()).not.toThrow()
    })

    it('should empty the queue', () => {
      const items = [mockRetryItem(), mockRetryItem(), mockRetryItem()]
      items.forEach((item) => queue.push(item))
      expect(queue.hasMore()).toBe(true)
      queue.retryAll()
      expect(queue.hasMore()).toBe(false)
      for (const item of items) expect(item.retry).toHaveBeenCalledOnce()
    })
  })

  describe('cancelAll', () => {
    it('should empty the queue', () => {
      const items = [mockRetryItem(), mockRetryItem(), mockRetryItem()]
      items.forEach((item) => queue.push(item))
      expect(queue.hasMore()).toBe(true)
      queue.cancelAll()
      expect(queue.hasMore()).toBe(false)
      for (const item of items) expect(item.cancel).toHaveBeenCalledOnce()
    })
  })
})

describe('retry queue promises', () => {
  it('AC-API-07: pushRetryFn settles with the retry outcome, or rejects with RetryCancelledError on cancel', async () => {
    const retried = queue.pushRetryFn('unauthorized-server', () => Promise.resolve('second time lucky'))
    const failed = queue.pushRetryFn('unauthorized-server', () => Promise.reject(new Error('still failing')))
    queue.retryAll()
    await expect(retried).resolves.toBe('second time lucky')
    await expect(failed).rejects.toThrow('still failing')

    const cancelled = queue.pushRetryFn('unauthenticated-client', () => 'never')
    queue.cancelAll()
    await expect(cancelled).rejects.toBeInstanceOf(RetryCancelledError)
  })

  it('AC-AUTH-05: retryAll retries the queued items in order', () => {
    const order: number[] = []
    void queue.pushRetryFn(undefined, () => order.push(1))
    void queue.pushRetryFn(undefined, () => order.push(2))
    void queue.pushRetryFn(undefined, () => order.push(3))
    queue.retryAll()
    expect(order).toEqual([1, 2, 3])
  })

  it('every push notifies the onItemAdded callbacks; a throwing callback does not stop the others', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen = vi.fn()
    queue.onItemAdded(() => {
      throw new Error('bad listener')
    })
    queue.onItemAdded(seen)
    queue.push(mockRetryItem())
    expect(seen).toHaveBeenCalledOnce()
    expect(errors).toHaveBeenCalledOnce()
  })
})
