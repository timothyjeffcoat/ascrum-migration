// S-p5-3 / AC-SEC-04 (Q-p5-10 (b)): login throttling, per account and per client IP, answered with 429.
// A deliberate difference from legacy, which never limited sign-ins; it only changes what an abusive
// client sees. handle() asks the throttle before it checks a password and tells it about each failure.
//
// Fixed windows, counted per key: the first failure starts a window of `windowSeconds`; once a key has
// `max` failures in its window, every sign-in for it is refused until the window ends (Retry-After says
// how long). Only failures count, so a busy office behind one NAT address is not limited by its
// successful sign-ins, and a success clears the account's count (not the IP's). A refused attempt is
// not counted, so hammering a blocked key does not push its window out.
//
// Two implementations: MemoryLoginThrottle (here) and PgLoginThrottle (api/src/pgThrottle.ts), which
// shares the counts between API containers. The in-memory stub (unit tests, `pnpm dev`, Playwright, the
// Pages demo) runs without a throttle unless a test gives it one, as legacy did.
import type { Clock } from './session.ts'

export type ThrottleLimits = {
  /** Failed sign-ins for one e-mail (exactly as sent, like the lookup) before it is blocked. */
  maxFailuresPerAccount: number
  /** Failed sign-ins from one client address before it is blocked. */
  maxFailuresPerIp: number
  windowSeconds: number
}

/**
 * 5 failures per account and 20 per address in 15 minutes. Five is the usual "a few typos" allowance;
 * twenty lets several people behind one NAT address mistype without locking each other out, and still
 * caps one address at 80 guesses an hour against all accounts together.
 */
export const DEFAULT_THROTTLE: ThrottleLimits = { maxFailuresPerAccount: 5, maxFailuresPerIp: 20, windowSeconds: 900 }

/** Who is signing in: the e-mail (absent when the body had none) and the client address (absent under MSW). */
export type LoginAttempt = { account: string | undefined; ip: string | undefined }

export interface LoginThrottle {
  /** Seconds until this attempt may be made; 0 when it is allowed now. */
  retryAfter(attempt: LoginAttempt): Promise<number>
  /** Counts a failed sign-in against the account and the address. */
  recordFailure(attempt: LoginAttempt): Promise<void>
  /** A successful sign-in: forgets the account's failures. */
  recordSuccess(account: string): Promise<void>
  /** Deletes counts whose window has ended; returns how many. */
  sweep(): Promise<number>
  /** Forgets everything (reset). */
  clear(): Promise<void>
}

/** The keys an attempt is counted under, with the limit for each. Prefixed so an e-mail is never an IP. */
export function throttleKeys(attempt: LoginAttempt, limits: ThrottleLimits): { key: string; max: number }[] {
  const keys: { key: string; max: number }[] = []
  if (attempt.account !== undefined) keys.push({ key: `account:${attempt.account}`, max: limits.maxFailuresPerAccount })
  if (attempt.ip !== undefined) keys.push({ key: `ip:${attempt.ip}`, max: limits.maxFailuresPerIp })
  return keys
}

type Window = { start: number; failures: number }

export class MemoryLoginThrottle implements LoginThrottle {
  readonly limits: ThrottleLimits
  readonly clock: Clock
  readonly windows = new Map<string, Window>()

  constructor(limits: ThrottleLimits, clock: Clock = Date.now) {
    this.limits = limits
    this.clock = clock
  }

  private live(key: string, now: number): Window | undefined {
    const window = this.windows.get(key)
    return window && now < window.start + this.limits.windowSeconds * 1000 ? window : undefined
  }

  async retryAfter(attempt: LoginAttempt): Promise<number> {
    const now = this.clock()
    let wait = 0
    for (const { key, max } of throttleKeys(attempt, this.limits)) {
      const window = this.live(key, now)
      if (window && window.failures >= max) {
        const ends = window.start + this.limits.windowSeconds * 1000
        wait = Math.max(wait, Math.ceil((ends - now) / 1000))
      }
    }
    return wait
  }

  async recordFailure(attempt: LoginAttempt): Promise<void> {
    const now = this.clock()
    for (const { key } of throttleKeys(attempt, this.limits)) {
      const window = this.live(key, now)
      if (window) window.failures += 1
      else this.windows.set(key, { start: now, failures: 1 })
    }
  }

  async recordSuccess(account: string): Promise<void> {
    this.windows.delete(`account:${account}`)
  }

  async sweep(): Promise<number> {
    const now = this.clock()
    let removed = 0
    for (const key of [...this.windows.keys()]) {
      if (!this.live(key, now)) {
        this.windows.delete(key)
        removed += 1
      }
    }
    return removed
  }

  async clear(): Promise<void> {
    this.windows.clear()
  }
}
