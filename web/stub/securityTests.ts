// p5-security (Phase 5 spec §3.4) tests for handle(), written once and run against both stores, like
// contractTests.ts: stub/handlers.test.ts runs them on MemoryStore + MemorySessions, and
// api/src/security.test.ts on PgStore + PgSessions + PgLoginThrottle (`pnpm test:integration`).
// What only the real API has (hashing, cookie flags over HTTP, configuration) is tested in api/.
import { beforeEach, describe, expect, it } from 'vitest'
import { body, Client, coll, type Backend } from './contractTests.ts'
import { handle, type StubContext, type StubResponse } from './handlers.ts'
import { CREDENTIALS, USER } from './seed.ts'

/** A clock the test moves by hand. */
export function manualClock(start = Date.UTC(2026, 10, 23, 9, 0, 0)) {
  let now = start
  const clock = () => now
  return Object.assign(clock, {
    advance(seconds: number) {
      now += seconds * 1000
    },
  })
}

const LIMITS = { maxFailuresPerAccount: 3, maxFailuresPerIp: 5, windowSeconds: 60 }
const wrong = (who: keyof typeof CREDENTIALS) => ({ email: CREDENTIALS[who].email, password: 'not-the-password' })

function cookie(res: StubResponse, name: string): string | undefined {
  return res.setCookies.find((c) => c.name === name)?.value
}

/**
 * Counts the store's password checks and makes each one take `delayMs`, as scrypt does (about 0.25 s at
 * production cost), so that attempts sent at once are all in flight together.
 */
function countPasswordChecks(ctx: StubContext, delayMs = 20): { count: number } {
  const original = ctx.store.findLogin.bind(ctx.store)
  const checks = { count: 0 }
  ctx.store.findLogin = async (email, password) => {
    checks.count += 1
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return original(email, password)
  }
  return checks
}

export function defineSecurityTests(backend: Backend): void {
  describe('AC-SEC-04 / S-p5-3: login throttling (Q-p5-10 (b))', () => {
    let clock: ReturnType<typeof manualClock>
    let ctx: StubContext
    beforeEach(async () => {
      clock = manualClock()
      ctx = await backend.createContext({ allowReset: true, throttle: LIMITS, clock })
    })

    /** A fresh browser (own session) at `ip` that tries one sign-in. */
    const attempt = async (creds: unknown, ip = '192.0.2.10') => {
      const client = await new Client(ctx, ip).prime()
      return { client, res: await client.call('POST', '/login', creds) }
    }

    it('AC-SEC-04: after the per-account limit of failures, that account gets 429 (even with the right password) until the window ends', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) {
        const { res } = await attempt(wrong('po'), `192.0.2.${i + 1}`) // different IPs: the account limit alone
        expect(res.status, `failure ${i + 1}`).toBe(200)
        expect(body(res)).toEqual({ user: null })
      }
      const { client, res: blocked } = await attempt(CREDENTIALS.po, '198.51.100.7')
      expect(blocked.status).toBe(429)
      expect(blocked.headers['Content-Type']).toBe('application/json')
      expect(body(blocked)).toEqual({ message: 'Too many failed sign-ins. Try again later.' })
      expect(Number(blocked.headers['Retry-After'])).toBe(LIMITS.windowSeconds)
      // Every response sets XSRF-TOKEN, a 429 too (spec §7.2), and the session is still anonymous.
      expect(cookie(blocked, 'XSRF-TOKEN')).toBeTruthy()
      expect(body(await client.call('GET', '/current-user'))).toEqual({ user: null })

      // Another account is not affected.
      expect(body((await attempt(CREDENTIALS.sm, '198.51.100.7')).res)).toMatchObject({ user: { id: USER.sm } })

      clock.advance(LIMITS.windowSeconds - 1)
      const later = (await attempt(CREDENTIALS.po, '198.51.100.8')).res
      expect(later.status).toBe(429)
      expect(Number(later.headers['Retry-After'])).toBe(1)
      clock.advance(1)
      expect(body((await attempt(CREDENTIALS.po, '198.51.100.8')).res)).toMatchObject({ user: { id: USER.po } })
    })

    it('AC-SEC-04: a successful sign-in clears the account’s failures', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount - 1; i++) await attempt(wrong('dev1'))
      expect(body((await attempt(CREDENTIALS.dev1)).res)).toMatchObject({ user: { id: USER.dev1 } })
      for (let i = 0; i < LIMITS.maxFailuresPerAccount - 1; i++) {
        expect((await attempt(wrong('dev1'))).res.status).toBe(200)
      }
      expect(body((await attempt(CREDENTIALS.dev1)).res)).toMatchObject({ user: { id: USER.dev1 } })
    })

    it('AC-SEC-04: after the per-IP limit of failures, every sign-in from that IP gets 429; other IPs do not', async () => {
      const accounts = ['po', 'sm', 'dev1', 'dev2', 'outsider'] as const
      expect(accounts).toHaveLength(LIMITS.maxFailuresPerIp)
      for (const who of accounts) expect((await attempt(wrong(who), '203.0.113.5')).res.status).toBe(200)
      const blocked = (await attempt(CREDENTIALS.admin, '203.0.113.5')).res
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers['Retry-After'])).toBe(LIMITS.windowSeconds)
      expect(body((await attempt(CREDENTIALS.admin, '203.0.113.6')).res)).toMatchObject({ user: { id: USER.admin } })
      // Unknown e-mails and malformed bodies count against the IP too: they are guesses as well.
      clock.advance(LIMITS.windowSeconds)
      for (const creds of [{ email: 'nobody@x', password: 'p' }, {}, undefined, { email: 'a@b' }, 'text']) {
        expect((await attempt(creds, '203.0.113.9')).res.status, JSON.stringify(creds)).toBe(200)
      }
      expect((await attempt(CREDENTIALS.admin, '203.0.113.9')).res.status).toBe(429)
    })

    it('AC-SEC-04: the account key is the e-mail exactly as sent, as the lookup is (DEV-p5-store-08)', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) {
        await attempt({ email: 'PO@ascrum.test', password: 'x' }, `192.0.2.${i + 1}`)
      }
      // 'PO@ascrum.test' is no account (exact match), so it does not lock out po@ascrum.test.
      expect(body((await attempt(CREDENTIALS.po, '198.51.100.1')).res)).toMatchObject({ user: { id: USER.po } })
    })

    it('AC-SEC-04: the XSRF check still comes first (403); the block ends with the window', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) await attempt(wrong('po'), `192.0.2.${i + 1}`)
      const noHeader = await new Client(ctx, '198.51.100.2').prime()
      noHeader.sendXsrf = false
      expect((await noHeader.call('POST', '/login', CREDENTIALS.po)).status).toBe(403)
      clock.advance(30)
      expect((await attempt(CREDENTIALS.po, '198.51.100.3')).res.status).toBe(429)
      clock.advance(LIMITS.windowSeconds - 30)
      expect(body((await attempt(CREDENTIALS.po, '198.51.100.3')).res)).toMatchObject({ user: { id: USER.po } })
    })

    it('AC-SEC-04: a reset clears the throttle (test control, like sessions)', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) await attempt(wrong('po'))
      expect((await attempt(CREDENTIALS.po)).res.status).toBe(429)
      await handle({ method: 'POST', path: '/__stub/reset', query: {}, headers: {}, cookies: {}, body: undefined }, ctx)
      expect(body((await attempt(CREDENTIALS.po)).res)).toMatchObject({ user: { id: USER.po } })
    })

    // DEV-p5-security-08 (review of #59): the throttle used to be asked before the password check and told
    // about the failure after it, so attempts sent at once all saw "under the limit". These tests send
    // them at once, with a password check as slow as scrypt makes it, and count how many got through.
    const statusCounts = (responses: StubResponse[]) => ({
      checked: responses.filter((r) => r.status === 200).length,
      refused: responses.filter((r) => r.status === 429).length,
    })

    it('AC-SEC-04 / DEV-p5-security-08: concurrent failures for one account reach the password check at most the per-account limit of times', async () => {
      const checks = countPasswordChecks(ctx)
      const n = 3 * LIMITS.maxFailuresPerAccount
      // Different IPs, so the account limit alone applies.
      const clients = await Promise.all(
        Array.from({ length: n }, (_, i) => new Client(ctx, `192.0.2.${i + 1}`).prime()),
      )
      const responses = await Promise.all(clients.map((c) => c.call('POST', '/login', wrong('po'))))
      expect(checks.count).toBe(LIMITS.maxFailuresPerAccount)
      expect(statusCounts(responses)).toEqual({
        checked: LIMITS.maxFailuresPerAccount,
        refused: n - LIMITS.maxFailuresPerAccount,
      })
      expect((await attempt(CREDENTIALS.po, '198.51.100.7')).res.status).toBe(429)
    })

    it('AC-SEC-04 / DEV-p5-security-08: concurrent failures from one address reach the password check at most the per-IP limit of times', async () => {
      const checks = countPasswordChecks(ctx)
      const n = 3 * LIMITS.maxFailuresPerIp
      const clients = await Promise.all(Array.from({ length: n }, () => new Client(ctx, '203.0.113.5').prime()))
      // A different unknown e-mail each time, so the per-account limit never applies.
      const responses = await Promise.all(
        clients.map((c, i) => c.call('POST', '/login', { email: `guess${i}@nowhere.test`, password: 'x' })),
      )
      expect(checks.count).toBe(LIMITS.maxFailuresPerIp)
      expect(statusCounts(responses)).toEqual({
        checked: LIMITS.maxFailuresPerIp,
        refused: n - LIMITS.maxFailuresPerIp,
      })
      expect((await attempt(CREDENTIALS.admin, '203.0.113.5')).res.status).toBe(429)
    })

    it('AC-SEC-04: successful sign-ins do not count against the address (only failures do)', async () => {
      // An attempt is counted before its password is checked (DEV-p5-security-08); a success gives the
      // address its count back, so an office behind one NAT address is not limited by its sign-ins.
      for (let i = 0; i < 2 * LIMITS.maxFailuresPerIp; i++) {
        expect(body((await attempt(CREDENTIALS.dev2, '203.0.113.7')).res), `sign-in ${i + 1}`).toMatchObject({
          user: { id: USER.dev2 },
        })
      }
      for (let i = 0; i < LIMITS.maxFailuresPerIp; i++) {
        const who = (['po', 'sm', 'dev1', 'po', 'sm'] as const)[i] ?? 'po'
        expect((await attempt(wrong(who), '203.0.113.7')).res.status, `failure ${i + 1}`).toBe(200)
      }
      expect((await attempt(CREDENTIALS.dev2, '203.0.113.7')).res.status).toBe(429)
    })

    it('AC-SEC-04: an attempt refused for its account is not counted against its address either', async () => {
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) await attempt(wrong('po'), `192.0.2.${i + 1}`)
      // More refusals from one address than its own limit: none of them may use up the address.
      for (let i = 0; i < 2 * LIMITS.maxFailuresPerIp; i++) {
        expect((await attempt(wrong('po'), '203.0.113.8')).res.status, `refusal ${i + 1}`).toBe(429)
      }
      expect(body((await attempt(CREDENTIALS.sm, '203.0.113.8')).res)).toMatchObject({ user: { id: USER.sm } })
      for (let i = 0; i < LIMITS.maxFailuresPerIp; i++) {
        const who = (['sm', 'dev1', 'dev2', 'sm', 'dev1'] as const)[i] ?? 'sm'
        expect((await attempt(wrong(who), '203.0.113.8')).res.status, `failure ${i + 1}`).toBe(200)
      }
    })

    it('AC-SEC-04 / DEV-p5-security-08: a password check that throws still counts as a failed attempt (fails closed)', async () => {
      const original = ctx.store.findLogin.bind(ctx.store)
      ctx.store.findLogin = () => Promise.reject(new Error('password check failed'))
      for (let i = 0; i < LIMITS.maxFailuresPerAccount; i++) {
        const client = await new Client(ctx, `192.0.2.${i + 1}`).prime()
        await expect(client.call('POST', '/login', wrong('po'))).rejects.toThrow('password check failed')
      }
      ctx.store.findLogin = original
      expect((await attempt(CREDENTIALS.po, '198.51.100.9')).res.status).toBe(429)
    })

    it('AC-SEC-04: without a throttle (the in-memory stub, as legacy) a sign-in is never 429', async () => {
      const open = await backend.createContext({ allowReset: true })
      const client = await new Client(open, '192.0.2.1').prime()
      for (let i = 0; i < 25; i++) expect((await client.call('POST', '/login', wrong('po'))).status).toBe(200)
      expect(body(await client.call('POST', '/login', CREDENTIALS.po))).toMatchObject({ user: { id: USER.po } })
    })
  })

  describe('session fixation: login rotates the session (p5-security)', () => {
    it('login issues a new sid (the XSRF token stays, Q-p5-security-2); the pre-login sid is gone and reads as a new anonymous session', async () => {
      const ctx = await backend.createContext({ allowReset: true })
      const client = await new Client(ctx).prime()
      const before = { ...client.cookies }
      expect(before.sid && before['XSRF-TOKEN']).toBeTruthy()

      const res = await client.call('POST', '/login', CREDENTIALS.dev1)
      expect(body(res)).toMatchObject({ user: { id: USER.dev1 } })
      expect(cookie(res, 'sid')).toBeTruthy()
      expect(cookie(res, 'sid')).not.toBe(before.sid)
      expect(cookie(res, 'XSRF-TOKEN')).toBe(before['XSRF-TOKEN'])
      const httpOnly = res.setCookies.find((c) => c.name === 'sid')?.httpOnly
      expect(httpOnly).toBe(true)

      // The new session works, writes included.
      expect(body(await client.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.dev1 } })
      expect((await client.call('POST', coll('tasks'), { name: 'after rotation' })).status).toBe(200)

      // Someone holding the old cookie (a fixation attacker who planted it) is not signed in, and with
      // the old sid even the right XSRF token is refused: the old session no longer exists.
      const attacker = new Client(ctx)
      attacker.cookies = { ...before }
      expect(body(await attacker.call('GET', '/current-user'))).toEqual({ user: null })
      expect(attacker.cookies.sid).not.toBe(before.sid)
      const stale = new Client(ctx)
      stale.cookies = { sid: before.sid ?? '', 'XSRF-TOKEN': before['XSRF-TOKEN'] ?? '' }
      expect((await stale.call('POST', coll('tasks'), { name: 'x' })).status).toBe(403)
    })

    it('a failed login keeps the session (nothing to protect yet), and logout still clears the user', async () => {
      const ctx = await backend.createContext({ allowReset: true })
      const client = await new Client(ctx).prime()
      const sid = client.cookies.sid
      const failed = await client.call('POST', '/login', wrong('po'))
      expect(cookie(failed, 'sid')).toBeUndefined()
      expect(client.cookies.sid).toBe(sid)
      await client.call('POST', '/login', CREDENTIALS.po)
      expect((await client.call('POST', '/logout')).status).toBe(204)
      expect(body(await client.call('GET', '/current-user'))).toEqual({ user: null })
    })
  })

  describe('DEV-p5-store-03: sessions expire after an idle lifetime', () => {
    it('DEV-p5-store-03: a session idle for longer than the lifetime is anonymous again; activity keeps it alive', async () => {
      const clock = manualClock()
      const ctx = await backend.createContext({ allowReset: true, sessionIdleSeconds: 600, clock })
      const client = await new Client(ctx).login('po')
      const sid = client.cookies.sid

      // Used every 10 minutes for an hour: still signed in, same sid.
      for (let i = 0; i < 6; i++) {
        clock.advance(600)
        expect(body(await client.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.po } })
      }
      expect(client.cookies.sid).toBe(sid)

      clock.advance(601)
      const expired = await client.call('GET', '/current-user')
      expect(body(expired)).toEqual({ user: null })
      expect(cookie(expired, 'sid')).toBeTruthy()
      expect(cookie(expired, 'sid')).not.toBe(sid) // a new anonymous session
    })

    it('DEV-p5-store-03: sweep() deletes expired sessions and only those', async () => {
      const clock = manualClock()
      const ctx = await backend.createContext({ allowReset: true, sessionIdleSeconds: 600, clock })
      await ctx.sessions.sweep()
      for (let i = 0; i < 3; i++) await new Client(ctx).prime() // three anonymous visitors (crawlers)
      clock.advance(300)
      const active = await new Client(ctx).login('dev2')
      clock.advance(301)
      expect(await ctx.sessions.sweep()).toBe(3)
      expect(await ctx.sessions.sweep()).toBe(0)
      expect(body(await active.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.dev2 } })
    })
  })

  describe('AC-SEC-03: no reset route without allowReset', () => {
    it('AC-SEC-03: POST /__stub/reset is 404 with or without the XSRF header, sets no cookie and resets nothing', async () => {
      const ctx = await backend.createContext({ allowReset: false })
      const admin = await new Client(ctx).login('admin')
      await admin.call('DELETE', coll('projects', '200000000000000000000001'))
      const call = (headers: Record<string, string>, cookies: Record<string, string> = {}) =>
        handle({ method: 'POST', path: '/__stub/reset', query: {}, headers, cookies, body: undefined }, ctx)

      for (const res of [
        await call({}), // no session, no header: what a scanner sends
        await call({ 'x-xsrf-token': 'wrong' }, admin.cookies),
        await call({ 'x-xsrf-token': admin.cookies['XSRF-TOKEN'] ?? '' }, admin.cookies),
      ]) {
        expect(res.status).toBe(404)
        expect(body(res)).toEqual({ message: 'Not found' })
        expect(res.setCookies).toEqual([])
      }
      // Nothing was reset: the admin is still signed in and the deleted project stays deleted.
      expect(body(await admin.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.admin } })
      expect((await admin.call('GET', coll('projects'))).body).not.toContain('Webshop')
    })

    it('AC-SEC-03: the XSRF rule is unchanged for every real route, and for unknown ones', async () => {
      const ctx = await backend.createContext({ allowReset: false })
      const client = await new Client(ctx).login('admin')
      client.sendXsrf = false
      for (const [method, path] of [
        ['POST', '/login'],
        ['POST', '/logout'],
        ['POST', coll('tasks')],
        ['PUT', coll('tasks', '600000000000000000000001')],
        ['DELETE', coll('projects', '200000000000000000000001')],
        ['POST', '/no-such-route'],
        ['POST', '/__stub/reset/x'],
      ] as const) {
        const res = await client.call(method, path, {})
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(res.body).toBe('Forbidden')
      }
    })
  })
}
