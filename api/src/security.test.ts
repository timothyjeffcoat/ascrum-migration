// p5-security (Phase 5 spec §3.4, AC-SEC-01..04) on the real API: PostgreSQL, real HTTP, the real
// configuration. Needs DATABASE_URL. AC-SEC-05 (headers, CSP) is a Playwright test: web/e2e/security.spec.ts.
import { cp, mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { body, Client, coll } from '../../web/stub/contractTests.ts'
import { JSON_PREFIX } from '../../web/stub/handlers.ts'
import { defineSecurityTests, manualClock } from '../../web/stub/securityTests.ts'
import { CREDENTIALS, USER } from '../../web/stub/seed.ts'
import { clientIpOf } from '../../web/stub/server.ts'
import { DEFAULT_SESSION_IDLE_SECONDS } from '../../web/stub/session.ts'
import { DEFAULT_THROTTLE } from '../../web/stub/throttle.ts'
import { loadConfig } from './config.ts'
import { startApi, type ApiOptions } from './main.ts'
import { migrate, MIGRATIONS_DIR } from './migrate.ts'
import { PRODUCTION_SCRYPT } from './passwords.ts'
import { PgSessions } from './pgSessions.ts'
import { PgStore } from './pgStore.ts'
import { emptySchema, pgBackend, pgContext, poolFor, TEST_SCRYPT } from './testDb.ts'

describe('p5-security on PgStore + PgSessions + PgLoginThrottle', () => {
  defineSecurityTests(pgBackend)
})

// --- helpers -------------------------------------------------------------------------------------

const running: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of running.splice(0)) await stop()
})

type Api = { base: string; pool: pg.Pool; server: Server }

// Production-cost scrypt is about 0.25 s per hash on a developer machine; the seed (6 users) plus 12
// sign-ins came within a few ms of Vitest's 5 s default under load (seen during the mutation runs).
const PRODUCTION_HASHING_TIMEOUT = 30_000

type ApiTestOptions = Partial<Omit<ApiOptions, 'pool' | 'port' | 'scrypt'>> & {
  /** true: startApi's own default hash cost (production). Otherwise the cheap test cost. */
  productionHashing?: boolean
}

/** The API on a fresh database (migrated and seeded by startApi itself), on a free port. */
async function api(options: ApiTestOptions = {}, schema?: string): Promise<Api> {
  const { productionHashing = false, ...settings } = options
  const pool = poolFor(schema ?? (await emptySchema()))
  const server = await startApi({ pool, port: 0, ...settings, ...(productionHashing ? {} : { scrypt: TEST_SCRYPT }) })
  running.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
  })
  return { base: `http://localhost:${(server.address() as AddressInfo).port}`, pool, server }
}

/** Settings as main.ts builds them from these environment variables. */
const fromEnv = (env: Record<string, string>) => loadConfig({ DATABASE_URL: 'postgres://unused', ...env }).settings
const settings = (env: Record<string, string>) => loadConfig({ DATABASE_URL: 'postgres://x', ...env }).settings

/** A browser over real HTTP: a cookie jar and the XSRF header, plus the raw Set-Cookie lines. */
function browser(base: string, extraHeaders: Record<string, string> = {}) {
  const jar = new Map<string, string>()
  const send = async (method: string, path: string, payload?: unknown) => {
    const headers: Record<string, string> = {
      ...extraHeaders,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    }
    const xsrf = jar.get('XSRF-TOKEN')
    if (xsrf && method !== 'GET') headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
    const res = await fetch(base + path, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const setCookies = res.headers.getSetCookie()
    for (const line of setCookies) {
      const [pair = ''] = line.split(';')
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
    }
    const text = await res.text()
    const json: unknown = text.startsWith(JSON_PREFIX) ? JSON.parse(text.slice(JSON_PREFIX.length)) : text
    return { status: res.status, headers: res.headers, setCookies, json }
  }
  return { jar, send }
}

/** The attributes of one Set-Cookie line, lower-cased names: {name, value, httponly: true, ...}. */
function attributes(lines: string[], name: string): Record<string, string | true> | undefined {
  const line = lines.find((l) => l.startsWith(`${name}=`))
  if (!line) return undefined
  const [pair = '', ...attrs] = line.split(';').map((s) => s.trim())
  const out: Record<string, string | true> = { name, value: pair.slice(name.length + 1) }
  for (const attr of attrs) {
    const eq = attr.indexOf('=')
    if (eq < 0) out[attr.toLowerCase()] = true
    else out[attr.slice(0, eq).toLowerCase()] = attr.slice(eq + 1)
  }
  return out
}

// --- AC-SEC-01 -----------------------------------------------------------------------------------

type UserRow = { id: string; email: string; password: string | null; password_hash: string | null }
const userRows = async (pool: pg.Pool) =>
  (await pool.query<UserRow>('SELECT id, email, password, password_hash FROM users ORDER BY seq')).rows

describe('AC-SEC-01 / S-p5-1: passwords are stored as scrypt hashes with a per-user salt', () => {
  it(
    'AC-SEC-01: no stored password equals its plain text, and every seed user can still sign in',
    async () => {
      const { base, pool } = await api({ productionHashing: true }) // the hash parameters main.ts uses
      const rows = await userRows(pool)
      expect(rows.map((r) => r.email)).toEqual(Object.values(CREDENTIALS).map((c) => c.email))
      const plain = new Set<string>(Object.values(CREDENTIALS).map((c) => c.password))
      for (const row of rows) {
        expect(row.password, row.email).toBeNull() // the pre-hashing column is empty
        expect(row.password_hash, row.email).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
        for (const p of plain) expect(row.password_hash?.includes(p), row.email).toBe(false)
      }
      // Five users share the password "demo": a per-user salt gives five different salts and hashes.
      const salts = rows.map((r) => r.password_hash?.split('$')[4])
      expect(new Set(salts).size).toBe(rows.length)
      expect(new Set(rows.map((r) => r.password_hash)).size).toBe(rows.length)
      expect(PRODUCTION_SCRYPT).toEqual({ log2N: 17, r: 8, p: 1 })

      for (const [who, creds] of Object.entries(CREDENTIALS)) {
        const { send } = browser(base)
        await send('GET', '/current-user')
        expect((await send('POST', '/login', creds)).json, who).toMatchObject({ user: { email: creds.email } })
        const { send: other } = browser(base)
        await other('GET', '/current-user')
        expect((await other('POST', '/login', { ...creds, password: `${creds.password}x` })).json).toEqual({
          user: null,
        })
      }
    },
    PRODUCTION_HASHING_TIMEOUT,
  )

  it('AC-SEC-01: passwords written through the API (POST, PUT) are hashed; a PUT without one keeps the hash (S8)', async () => {
    const ctx = await pgContext({ allowReset: true })
    const admin = await new Client(ctx).login('admin')
    const created = body(
      await admin.call('POST', coll('users'), { email: 'new@x.test', password: 'pw-one', firstName: 'N' }),
    ) as { _id: { $oid: string } }
    const id = created._id.$oid
    const hashOf = async () =>
      (await ctx.store.pool.query<UserRow>('SELECT password, password_hash FROM users WHERE id = $1', [id])).rows[0]
    const first = await hashOf()
    expect(first?.password).toBeNull()
    expect(first?.password_hash).toMatch(/^scrypt\$/)
    expect(first?.password_hash).not.toContain('pw-one')

    await admin.call('PUT', coll('users', id), { email: 'new@x.test', firstName: 'Renamed' })
    expect((await hashOf())?.password_hash).toBe(first?.password_hash)
    const login = async (password: string) =>
      body(await (await new Client(ctx).prime()).call('POST', '/login', { email: 'new@x.test', password }))
    expect(await login('pw-one')).toMatchObject({ user: { id, firstName: 'Renamed' } })

    await admin.call('PUT', coll('users', id), { email: 'new@x.test', password: 'pw-two', firstName: 'R' })
    const second = await hashOf()
    expect(second?.password_hash).not.toBe(first?.password_hash)
    expect(second?.password_hash).not.toContain('pw-two')
    expect(await login('pw-one')).toEqual({ user: null })
    expect(await login('pw-two')).toMatchObject({ user: { id } })

    // A password that is not a string can never sign in (login needs a non-empty string), so it is not
    // stored at all rather than kept in `extra` as plain data.
    await admin.call('PUT', coll('users', id), { email: 'new@x.test', password: 12345, firstName: 'R' })
    const third = await ctx.store.pool.query('SELECT password, password_hash, extra FROM users WHERE id = $1', [id])
    expect(third.rows[0]).toEqual({ password: null, password_hash: null, extra: {} })
    expect(await login('12345')).toEqual({ user: null })
    expect(await login('pw-two')).toEqual({ user: null })
  })

  it(
    'AC-SEC-01: a database written before hashing (plain passwords from migration 001) is hashed when the API starts',
    async () => {
      const schema = await emptySchema()
      const old = poolFor(schema)
      const only001 = await mkdtemp(join(tmpdir(), 'ascrum-001-'))
      try {
        await cp(join(MIGRATIONS_DIR, '001_initial_schema.sql'), join(only001, '001_initial_schema.sql'))
        expect(await migrate(old, only001)).toEqual(['001'])
      } finally {
        await rm(only001, { recursive: true, force: true })
      }
      await old.query(
        `INSERT INTO users (id, email, password, first_name, admin) VALUES
       ('a00000000000000000000001', 'early@x.test', 'early-pw', 'Early', false)`,
      )
      await old.end()

      const { base, pool } = await api({ productionHashing: true }, schema)
      const [row] = await userRows(pool)
      expect(row?.password).toBeNull()
      expect(row?.password_hash).toMatch(/^scrypt\$17\$/)
      expect(row?.password_hash).not.toContain('early-pw')
      const { send } = browser(base)
      await send('GET', '/current-user')
      expect((await send('POST', '/login', { email: 'early@x.test', password: 'early-pw' })).json).toMatchObject({
        user: { firstName: 'Early' },
      })
    },
    PRODUCTION_HASHING_TIMEOUT,
  )
})

// --- DEV-p5-store-10 -----------------------------------------------------------------------------

describe('DEV-p5-store-10: the login lookup never puts the e-mail into SQL text', () => {
  it('DEV-p5-store-10: every statement a sign-in sends carries the e-mail as a bind parameter only', async () => {
    const statements: { text: string; values: unknown[] }[] = []
    // Every query, pool.query() included, runs on a pooled client; record what each one sends. The
    // listener is in place before the pool opens its first connection.
    const pool = poolFor(await emptySchema())
    const record = (client: pg.PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown
      Object.assign(client, {
        query: (...args: unknown[]) => {
          const [first, second] = args
          const text = typeof first === 'string' ? first : String((first as { text?: unknown }).text)
          const values = Array.isArray(second) ? second : ((first as { values?: unknown[] }).values ?? [])
          statements.push({ text, values })
          return original(...args)
        },
      })
    }
    pool.on('connect', record)
    await migrate(pool)
    const store = new PgStore(pool, { scrypt: TEST_SCRYPT })
    await store.reset()
    const ctx = { store, sessions: new PgSessions(pool), allowReset: false }
    const marker = `marker-${crypto.randomUUID()}$e$'"@x.test`
    const fresh = new Client(ctx)
    await fresh.prime()
    statements.length = 0
    await fresh.call('POST', '/login', { email: marker, password: CREDENTIALS.admin.password })
    await fresh.call('POST', '/login', { email: CREDENTIALS.po.email, password: 'wrong' })
    const lookups = statements.filter((s) => /FROM users/.test(s.text))
    expect(lookups.length).toBeGreaterThanOrEqual(2)
    for (const s of statements) {
      expect(s.text).not.toContain('marker-')
      expect(s.text).not.toContain(CREDENTIALS.po.email)
    }
    expect(lookups.some((s) => s.values.includes(marker))).toBe(true)
    expect(lookups.some((s) => s.values.includes(CREDENTIALS.po.email))).toBe(true)
  })
})

// --- AC-SEC-02 -----------------------------------------------------------------------------------

describe('AC-SEC-02 / S-p5-2: cookie flags', () => {
  it('AC-SEC-02: in production mode sid is HttpOnly; Secure; SameSite=Lax, and XSRF-TOKEN is Secure; SameSite=Lax and readable by script', async () => {
    const { base } = await api(fromEnv({ APP_ENV: 'production' }))
    const { send } = browser(base)
    const first = await send('GET', '/current-user')
    const login = await send('POST', '/login', CREDENTIALS.po) // rotation sets both cookies again
    expect(login.json).toMatchObject({ user: { id: USER.po } })
    for (const res of [first, login]) {
      expect(attributes(res.setCookies, 'sid')).toEqual({
        name: 'sid',
        value: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        path: '/',
        httponly: true,
        secure: true,
        samesite: 'Lax',
      })
      expect(attributes(res.setCookies, 'XSRF-TOKEN')).toEqual({
        name: 'XSRF-TOKEN',
        value: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        path: '/',
        secure: true,
        samesite: 'Lax',
      })
    }
  })

  it('AC-SEC-02 / AC-SEC-03 / DEV-p5-security-11: startApi() with no settings at all is production: Secure cookies, no reset route, throttling on', async () => {
    // Every other cookie test passes `production` explicitly, so startApi()'s own default was unpinned.
    const { base } = await api() // no production, allowReset or throttle: only the pool and port
    const { send } = browser(base)
    const res = await send('GET', '/current-user')
    expect(attributes(res.setCookies, 'sid')).toMatchObject({ httponly: true, secure: true, samesite: 'Lax' })
    expect(attributes(res.setCookies, 'XSRF-TOKEN')).toMatchObject({ secure: true, samesite: 'Lax' })
    expect((await send('POST', '/__stub/reset')).status).toBe(404)
    const wrong = { email: CREDENTIALS.po.email, password: 'not-the-password' }
    for (let i = 0; i < DEFAULT_THROTTLE.maxFailuresPerAccount; i++) {
      expect((await send('POST', '/login', wrong)).status, `failure ${i + 1}`).toBe(200)
    }
    expect((await send('POST', '/login', CREDENTIALS.po)).status).toBe(429)
  })

  it('AC-SEC-02: in development mode (plain http://localhost) the cookies carry no Secure flag; the rest is the same', async () => {
    const { base } = await api(fromEnv({ APP_ENV: 'development' }))
    const { send } = browser(base)
    const res = await send('GET', '/current-user')
    expect(attributes(res.setCookies, 'sid')).toMatchObject({ httponly: true, samesite: 'Lax' })
    expect(attributes(res.setCookies, 'sid')).not.toHaveProperty('secure')
    expect(attributes(res.setCookies, 'XSRF-TOKEN')).toMatchObject({ samesite: 'Lax' })
    expect(attributes(res.setCookies, 'XSRF-TOKEN')).not.toHaveProperty('secure')
    expect(attributes(res.setCookies, 'XSRF-TOKEN')).not.toHaveProperty('httponly')
  })
})

describe('configuration (api/src/config.ts): production mode and limits from the environment', () => {
  it('AC-SEC-02: APP_ENV unset means production (fail closed); only APP_ENV=development turns it off', () => {
    expect(settings({}).production).toBe(true)
    expect(settings({ APP_ENV: 'production' }).production).toBe(true)
    expect(settings({ APP_ENV: 'development' }).production).toBe(false)
    expect(() => settings({ APP_ENV: 'prod' })).toThrow(/APP_ENV/)
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
    expect(loadConfig({ DATABASE_URL: 'postgres://db' }).databaseUrl).toBe('postgres://db')
  })

  it('AC-SEC-03: ALLOW_RESET=1 is refused in production mode, so a production API cannot have the reset route', () => {
    expect(() => settings({ ALLOW_RESET: '1' })).toThrow(/ALLOW_RESET/)
    expect(() => settings({ APP_ENV: 'production', ALLOW_RESET: '1' })).toThrow(/ALLOW_RESET/)
    expect(settings({ APP_ENV: 'development', ALLOW_RESET: '1' }).allowReset).toBe(true)
    expect(settings({ APP_ENV: 'development' }).allowReset).toBe(false)
    expect(settings({}).allowReset).toBe(false)
  })

  it('AC-SEC-04: the stated defaults, each overridable; a bad number is refused at start-up', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).port).toBe(3000)
    expect(settings({})).toMatchObject({
      trustProxyHops: 0,
      sessionIdleSeconds: DEFAULT_SESSION_IDLE_SECONDS,
      sweepIntervalSeconds: 600,
      throttle: DEFAULT_THROTTLE,
    })
    expect(DEFAULT_THROTTLE).toEqual({ maxFailuresPerAccount: 5, maxFailuresPerIp: 20, windowSeconds: 900 })
    expect(DEFAULT_SESSION_IDLE_SECONDS).toBe(8 * 60 * 60)
    expect(loadConfig({ DATABASE_URL: 'postgres://x', PORT: '8080' }).port).toBe(8080)
    const custom = settings({
      TRUST_PROXY_HOPS: '2',
      SESSION_IDLE_SECONDS: '1800',
      SESSION_SWEEP_SECONDS: '60',
      LOGIN_MAX_FAILURES_PER_ACCOUNT: '10',
      LOGIN_MAX_FAILURES_PER_IP: '100',
      LOGIN_THROTTLE_WINDOW_SECONDS: '300',
    })
    expect(custom).toMatchObject({
      trustProxyHops: 2,
      sessionIdleSeconds: 1800,
      sweepIntervalSeconds: 60,
      throttle: { maxFailuresPerAccount: 10, maxFailuresPerIp: 100, windowSeconds: 300 },
    })
    for (const bad of ['0', '-1', '1.5', 'ten', '']) {
      expect(() => settings({ LOGIN_MAX_FAILURES_PER_IP: bad }), bad).toThrow(/LOGIN_MAX_FAILURES_PER_IP/)
    }
    expect(() => settings({ TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/)
    expect(settings({ TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0)
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: 'http' })).toThrow(/PORT/)
  })
})

// --- AC-SEC-03 -----------------------------------------------------------------------------------

describe('AC-SEC-03: the production API has no reset route', () => {
  it('AC-SEC-03: POST /__stub/reset answers 404 with no session, no cookie and no XSRF header, and changes nothing', async () => {
    const { base, pool } = await api(fromEnv({ APP_ENV: 'production' }))
    const sessions = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions')).rows[0]?.n
    const bare = await fetch(`${base}/__stub/reset`, { method: 'POST' })
    expect(bare.status).toBe(404)
    expect(await bare.text()).toBe(`${JSON_PREFIX}{"message":"Not found"}`)
    expect(bare.headers.getSetCookie()).toEqual([])
    expect(await sessions()).toBe(0) // a scanner hitting the path does not even create a session row

    const { send } = browser(base)
    await send('GET', '/current-user')
    expect((await send('POST', '/login', CREDENTIALS.admin)).json).toMatchObject({ user: { admin: true } })
    expect((await send('DELETE', '/databases/ascrum/collections/tasks/500000000000000000000001')).status).toBe(200)
    expect((await send('POST', '/__stub/reset')).status).toBe(404) // with a valid token too
    expect((await send('GET', '/__stub/reset')).status).toBe(404)
    expect((await send('GET', '/databases/ascrum/collections/tasks/500000000000000000000001')).status).toBe(404)
    expect((await send('GET', '/current-user')).json).toMatchObject({ user: { admin: true } })
  })
})

// --- AC-SEC-04 over HTTP: which address is the client -------------------------------------------

describe('AC-SEC-04: the client address for per-IP throttling', () => {
  it('AC-SEC-04: clientIpOf trusts exactly TRUST_PROXY_HOPS entries from the right of X-Forwarded-For', () => {
    const xff = (value?: string) => ({ remoteAddress: '10.0.0.9', forwardedFor: value })
    expect(clientIpOf(xff('203.0.113.1'), 0)).toBe('10.0.0.9') // trust no proxy: the socket address
    expect(clientIpOf(xff(), 1)).toBe('10.0.0.9')
    expect(clientIpOf(xff('203.0.113.1'), 1)).toBe('203.0.113.1')
    // A client can prepend anything; the entries our proxies appended are on the right.
    expect(clientIpOf(xff('6.6.6.6, 203.0.113.1'), 1)).toBe('203.0.113.1')
    expect(clientIpOf(xff('6.6.6.6, 203.0.113.1, 198.51.100.2'), 2)).toBe('203.0.113.1')
    // Fewer entries than trusted hops: the left-most one we have (it came through at least one hop).
    expect(clientIpOf(xff('203.0.113.1'), 2)).toBe('203.0.113.1')
    expect(clientIpOf({ remoteAddress: '::ffff:192.0.2.4', forwardedFor: undefined }, 0)).toBe('192.0.2.4')
    expect(clientIpOf({ remoteAddress: undefined, forwardedFor: undefined }, 0)).toBeUndefined()
  })

  const limits = { maxFailuresPerAccount: 50, maxFailuresPerIp: 2, windowSeconds: 60 }
  const failFrom = async (base: string, forwardedFor?: string) => {
    const { send } = browser(base, forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {})
    await send('GET', '/current-user')
    return send('POST', '/login', { email: 'nobody@x.test', password: 'guess' })
  }

  it('AC-SEC-04: with no trusted proxy (the default) a spoofed X-Forwarded-For does not escape the per-IP limit', async () => {
    const { base } = await api({ throttle: limits, trustProxyHops: 0 })
    expect((await failFrom(base, '203.0.113.1')).status).toBe(200)
    expect((await failFrom(base, '203.0.113.2')).status).toBe(200)
    const blocked = await failFrom(base, '203.0.113.3')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('60')
    expect(blocked.json).toEqual({ message: 'Too many failed sign-ins. Try again later.' })
  })

  it('AC-SEC-04: behind one trusted proxy the address it appended is the key; what the client prepends is ignored', async () => {
    const { base } = await api({ throttle: limits, trustProxyHops: 1 })
    expect((await failFrom(base, '1.1.1.1, 203.0.113.1')).status).toBe(200)
    expect((await failFrom(base, '2.2.2.2, 203.0.113.1')).status).toBe(200)
    expect((await failFrom(base, '3.3.3.3, 203.0.113.1')).status).toBe(429)
    expect((await failFrom(base, '203.0.113.2')).status).toBe(200) // another client behind the same proxy
  })
})

// --- DEV-p5-security-08: concurrent sign-ins, on the real API with every production default ------

describe('AC-SEC-04 / DEV-p5-security-08: sign-ins sent at once cannot get past the limits', () => {
  // The review's probe: wrong passwords sent all at once, over HTTP, with production hashing and the
  // default limits. A 200 {user:null} means the password was checked (handle() answers it only after
  // the store's scrypt check); a 429 means it was refused before. The table must agree.
  const sendAtOnce = async (base: string, n: number, creds: (i: number) => unknown) => {
    const browsers = await Promise.all(
      Array.from({ length: n }, async () => {
        const b = browser(base)
        await b.send('GET', '/current-user')
        return b
      }),
    )
    const responses = await Promise.all(browsers.map((b, i) => b.send('POST', '/login', creds(i))))
    return {
      checked: responses.filter((r) => r.status === 200).length,
      refused: responses.filter((r) => r.status === 429).length,
    }
  }
  const failures = async (pool: pg.Pool) =>
    Object.fromEntries(
      (await pool.query<{ key: string; failures: number }>('SELECT key, failures FROM login_throttle')).rows.map(
        (r) => [r.key.replace(/^ip:.*/, 'ip'), r.failures],
      ),
    )

  it(
    'AC-SEC-04 / DEV-p5-security-08: 3× the per-account limit of wrong passwords at once: only the limit are checked, the rest get 429',
    async () => {
      const { base, pool } = await api({ productionHashing: true })
      const limit = DEFAULT_THROTTLE.maxFailuresPerAccount
      const n = 3 * limit // below the per-IP limit (20), so the account limit alone applies
      expect(n).toBeLessThan(DEFAULT_THROTTLE.maxFailuresPerIp)
      const wrong = { email: CREDENTIALS.po.email, password: 'not-the-password' }
      expect(await sendAtOnce(base, n, () => wrong)).toEqual({ checked: limit, refused: n - limit })
      expect(await failures(pool)).toEqual({ [`account:${CREDENTIALS.po.email}`]: limit, ip: limit })
    },
    PRODUCTION_HASHING_TIMEOUT,
  )

  it(
    'AC-SEC-04 / DEV-p5-security-08: 3× the per-IP limit of wrong sign-ins at once from one address: only the limit are checked, the rest get 429',
    async () => {
      const { base, pool } = await api({ productionHashing: true })
      const limit = DEFAULT_THROTTLE.maxFailuresPerIp
      const n = 3 * limit
      const guess = (i: number) => ({ email: `guess${i}@nowhere.test`, password: 'x' }) // one try per e-mail
      expect(await sendAtOnce(base, n, guess)).toEqual({ checked: limit, refused: n - limit })
      const counted = await failures(pool)
      expect(counted.ip).toBe(limit)
      expect(Object.keys(counted).filter((k) => k.startsWith('account:'))).toHaveLength(limit)
    },
    PRODUCTION_HASHING_TIMEOUT,
  )
})

// --- DEV-p5-store-03 in the running API ----------------------------------------------------------

describe('DEV-p5-store-03: the API sweeps expired sessions on a timer', () => {
  it('DEV-p5-store-03: expired session rows are deleted without any request touching them', async () => {
    const clock = manualClock()
    const { base, pool } = await api({ sessionIdleSeconds: 60, sweepIntervalSeconds: 0.05, clock })
    for (let i = 0; i < 4; i++) await fetch(`${base}/current-user`) // four cookie-less health checks
    const count = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions')).rows[0]?.n
    expect(await count()).toBe(4)
    clock.advance(61)
    await expect.poll(count, { timeout: 2000 }).toBe(0)
  })
})
