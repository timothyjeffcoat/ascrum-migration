// S-p5-3 / AC-SEC-04 (Q-p5-10 (b)): login throttling, per account and per client IP, answered with 429.
// The per-IP key is the IPv4 address, or an IPv6 address's /64 (addressKey(), DEV-p5-security-13).
// A deliberate difference from legacy, which never limited sign-ins; it only changes what an abusive
// client sees.
//
// Fixed windows, counted per key: the first failure starts a window of `windowSeconds`; once a key has
// `max` failures in its window, every sign-in for it is refused until the window ends (Retry-After says
// how long). Only failures count, so a busy office behind one NAT address is not limited by its
// successful sign-ins, and a success clears the account's count (not the IP's). A refused attempt is
// not counted, so hammering a blocked key does not push its window out.
//
// DEV-p5-security-08: every attempt is counted *before* its password is checked. handle() used to ask
// "may this attempt go ahead?" first and report the failure after the (0.25 s) scrypt check, so attempts
// sent at once all saw "under the limit": 100 of them for one account all reached the password check.
// Now admit() takes one failure off each key's allowance in a single atomic step, or refuses; a right
// password then gives the count back (succeeded()), a wrong one keeps it. At most `max` attempts per key
// and window can therefore reach the password check, however many arrive together. The price: while
// `max` sign-ins for one key are in flight at once, one more is refused even if all of them turn out to
// be right (only possible with `max` concurrent sign-ins from one account or address).
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

/** One failure counted in advance against a key, in the window that started at `windowStart` (ms). */
export type ReservedKey = { key: string; windowStart: number }

/** What admit() counted for an attempt that may go ahead. */
export type Reservation = { attempt: LoginAttempt; keys: ReservedKey[] }

export type Admission = { allowed: true; reservation: Reservation } | { allowed: false; retryAfter: number }

export interface LoginThrottle {
  /**
   * Counts the attempt as a failure against every key, atomically, unless a key is already at its limit:
   * then nothing is counted and the attempt is refused (retryAfter: seconds until it may be made).
   * Called before the password is checked (DEV-p5-security-08).
   */
  admit(attempt: LoginAttempt): Promise<Admission>
  /** The password was right: forgets the account's failures and gives the address back its count. */
  succeeded(reservation: Reservation): Promise<void>
  /** Deletes counts whose window has ended; returns how many. */
  sweep(): Promise<number>
  /** Forgets everything (reset). */
  clear(): Promise<void>
}

/**
 * The keys an attempt is counted under, with the limit for each. Prefixed so an e-mail is never an IP.
 * The address comes first: PgLoginThrottle reserves in this order, so an attempt from a blocked address
 * is refused before it touches the account's count.
 */
export function throttleKeys(attempt: LoginAttempt, limits: ThrottleLimits): { key: string; max: number }[] {
  const keys: { key: string; max: number }[] = []
  if (attempt.ip !== undefined) keys.push({ key: `ip:${addressKey(attempt.ip)}`, max: limits.maxFailuresPerIp })
  if (attempt.account !== undefined) keys.push({ key: `account:${attempt.account}`, max: limits.maxFailuresPerAccount })
  return keys
}

/** The address key among an attempt's reserved keys (throttleKeys() made it; at most one). */
export function reservedAddress(reservation: Reservation): ReservedKey | undefined {
  return reservation.keys.find((k) => k.key.startsWith('ip:'))
}

/**
 * DEV-p5-security-13: the client address as the per-IP limit counts it.
 *   - IPv4: the address itself.
 *   - IPv6: its /64 prefix, e.g. `2001:db8:0:1::/64`. One subscriber usually gets a whole /64 and can
 *     pick a new address in it for every attempt (privacy extensions do so on their own), so keying the
 *     full address would give an IPv6 client 2^64 allowances instead of one. The price: clients that
 *     share a /64 (one home, one office LAN) share the allowance, as clients behind one IPv4 NAT do.
 *   - IPv4-mapped IPv6 (`::ffff:192.0.2.1`, in any spelling): the IPv4 address it carries, so one IPv4
 *     client has one key whether it arrived on a dual-stack socket or not.
 * Any spelling of an IPv6 address gives the same key: upper or lower case, leading zeros, `::` anywhere,
 * an embedded dotted IPv4 tail, square brackets, and a zone id (`fe80::1%eth0`, which names one of our
 * interfaces, not the client) are all normalised. Anything that is not an IP address is keyed as given
 * (lower-cased): clientIpOf() passes on what the socket or a trusted proxy said, so this only happens
 * if a trusted proxy sends something odd, and then that client still has a key of its own.
 */
export function addressKey(ip: string): string {
  const address = ip
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/%.*$/, '')
  if (!address.includes(':')) return address
  const groups = ipv6Groups(address)
  if (!groups) return address
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 0xff, h >> 8, h & 0xff].join('.')
  }
  return `${[a, b, c, d].map((n) => n.toString(16)).join(':')}::/64`
}

/** The eight 16-bit groups of an IPv6 address, or undefined if `address` is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address
  // A dotted IPv4 tail (::ffff:192.0.2.1) stands for the last two groups.
  const tail = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (tail) {
    const bytes = tail.slice(1).map(Number)
    if (bytes.some((n) => n > 255)) return undefined
    const [w = 0, x = 0, y = 0, z = 0] = bytes
    text = `${text.slice(0, tail.index)}:${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const split = (part: string | undefined) => (part ? part.split(':') : [])
  const head = split(halves[0])
  const rest = split(halves[1])
  const missing = 8 - head.length - rest.length
  // `::` stands for at least one group of zeros; without it there must be exactly eight groups.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  return all.map((group) => parseInt(group, 16))
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

  // No await between the check and the count: JavaScript runs this to the end before any other request
  // can, so it is atomic here. PgLoginThrottle needs the database to make it so.
  async admit(attempt: LoginAttempt): Promise<Admission> {
    const now = this.clock()
    const keys = throttleKeys(attempt, this.limits)
    let wait = 0
    for (const { key, max } of keys) {
      const window = this.live(key, now)
      if (window && window.failures >= max) {
        const ends = window.start + this.limits.windowSeconds * 1000
        wait = Math.max(wait, Math.ceil((ends - now) / 1000))
      }
    }
    if (wait > 0) return { allowed: false, retryAfter: wait }
    const reserved: ReservedKey[] = []
    for (const { key } of keys) {
      const window = this.live(key, now) ?? { start: now, failures: 0 }
      window.failures += 1
      this.windows.set(key, window)
      reserved.push({ key, windowStart: window.start })
    }
    return { allowed: true, reservation: { attempt, keys: reserved } }
  }

  async succeeded(reservation: Reservation): Promise<void> {
    const { account } = reservation.attempt
    if (account !== undefined) this.windows.delete(`account:${account}`)
    const reservedIp = reservedAddress(reservation)
    const window = reservedIp && this.windows.get(reservedIp.key)
    // Only in the window the attempt was counted in; a newer window never held it.
    if (reservedIp && window && window.start === reservedIp.windowStart) {
      window.failures -= 1
      if (window.failures <= 0) this.windows.delete(reservedIp.key)
    }
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
