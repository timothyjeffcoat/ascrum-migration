// Contract tests for handle() (spec §7.5, AC-STUB-01..15), written once and run against every store
// (Phase 5, spec §3.1, AC-PG-01):
//   - stub/handlers.test.ts runs them on the in-memory store (`pnpm test`);
//   - api/src/pgStore.test.ts runs them on PostgreSQL (`pnpm test:integration`).
// They call handle() directly; defineNodeAdapterTests() below runs a flow over real HTTP.
//
// "Store parity" pins down what the in-memory arrays gave for free and a database does not: order,
// value types, absent vs empty vs null, dangling references, strict equality in `q`.
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createStubContext,
  handle,
  INVALID_JSON,
  JSON_PREFIX,
  type StubContext,
  type StubResponse,
} from './handlers.ts'
import { BACKLOG, CREDENTIALS, PROJECT, SPRINT, USER } from './seed.ts'
import { startStubServer } from './server.ts'
import { COLLECTIONS, type WireDoc } from './store.ts'

/** A store under test. Every context it creates is fresh, seeded and independent of the others. */
export type Backend = {
  name: string
  createContext(opts: { allowReset: boolean }): Promise<StubContext>
}

/** The in-memory store: `pnpm test` runs every suite here on it. */
export const memoryBackend: Backend = {
  name: 'MemoryStore',
  createContext: async (opts) => createStubContext(opts),
}

/** A tiny browser: keeps cookies between calls and sends X-XSRF-TOKEN like AngularJS $http did. */
export class Client {
  cookies: Record<string, string> = {}
  sendXsrf = true
  readonly ctx: StubContext
  constructor(ctx: StubContext) {
    this.ctx = ctx
  }

  async call(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<StubResponse> {
    const headers: Record<string, string | undefined> = {}
    if (this.sendXsrf && this.cookies['XSRF-TOKEN']) headers['x-xsrf-token'] = this.cookies['XSRF-TOKEN']
    const res = await handle({ method, path, query, headers, cookies: { ...this.cookies }, body }, this.ctx)
    for (const c of res.setCookies) this.cookies[c.name] = c.value
    return res
  }

  /** First GET, so the client holds an XSRF token, as a browser would after loading the app. */
  async prime(): Promise<this> {
    await this.call('GET', '/current-user')
    return this
  }

  async login(who: keyof typeof CREDENTIALS): Promise<this> {
    await this.prime()
    const res = await this.call('POST', '/login', CREDENTIALS[who])
    expect(body(res)).toMatchObject({ user: { email: CREDENTIALS[who].email } })
    return this
  }
}

/**
 * Login e-mails that are SQL if a lookup splices them into a string (DEV-p5-store-07). Each would sign
 * in as the admin when sent with the admin's password; with parameters each is just an unknown e-mail.
 */
export const INJECTED_EMAILS = [
  "nobody' OR email = 'admin@abc.com",
  "' OR '1'='1",
  "admin@abc.com' --",
  "x' OR admin --",
  "x' UNION SELECT id FROM users WHERE admin --",
]

export function body(res: StubResponse): unknown {
  expect(res.body?.startsWith(JSON_PREFIX)).toBe(true)
  return JSON.parse((res.body ?? '').slice(JSON_PREFIX.length)) as unknown
}

export const coll = (c: string, id?: string) => `/databases/ascrum/collections/${c}${id ? `/${id}` : ''}`
export const q = (value: unknown) => ({ q: JSON.stringify(value) })
export const ids = (res: StubResponse) => (body(res) as { _id: { $oid: string } }[]).map((d) => d._id.$oid)
export const reset = (ctx: StubContext) =>
  handle({ method: 'POST', path: '/__stub/reset', query: {}, headers: {}, cookies: {}, body: undefined }, ctx)

/** Every collection as an anonymous client reads it: raw response bodies, so byte-level differences show. */
export async function dumpCollections(ctx: StubContext): Promise<Record<string, string | null>> {
  const client = await new Client(ctx).prime()
  const out: Record<string, string | null> = {}
  for (const c of COLLECTIONS) out[c] = (await client.call('GET', coll(c))).body
  return out
}

export function defineContractTests(backend: Backend): void {
  let ctx: StubContext
  let anon: Client
  beforeEach(async () => {
    ctx = await backend.createContext({ allowReset: true })
    anon = await new Client(ctx).prime()
  })

  describe('transport', () => {
    it("AC-STUB-01: JSON responses carry the )]}', prefix and a JSON content type", async () => {
      const res = await anon.call('GET', coll('projects'))
      expect(res.headers['Content-Type']).toBe('application/json')
      expect(res.body?.startsWith(")]}',\n")).toBe(true)
      expect(body(res)).toHaveLength(3)
    })

    it('AC-STUB-02: XSRF-TOKEN is set on every response and stable within a session', async () => {
      const first = anon.cookies['XSRF-TOKEN']
      expect(first).toBeTruthy()
      for (const res of [
        await anon.call('GET', coll('users')),
        await anon.call('POST', '/logout'),
        await anon.call('GET', '/nope'),
      ]) {
        expect(res.setCookies.find((c) => c.name === 'XSRF-TOKEN')?.value).toBe(first)
      }
      const other = await new Client(ctx).prime()
      expect(other.cookies['XSRF-TOKEN']).not.toBe(first)
    })

    it('AC-STUB-03: an unsafe method without the matching header is 403 "Forbidden", before auth, including /login', async () => {
      anon.sendXsrf = false
      const login = await anon.call('POST', '/login', CREDENTIALS.admin)
      expect(login).toMatchObject({ status: 403, body: 'Forbidden', headers: { 'Content-Type': 'text/plain' } })
      // Anonymous write: XSRF (403) wins over auth (401).
      expect((await anon.call('POST', coll('tasks'), { name: 'x' })).status).toBe(403)
      // A wrong token is as bad as none.
      const res = await handle(
        {
          method: 'PUT',
          path: coll('tasks', 'x'),
          query: {},
          headers: { 'x-xsrf-token': 'wrong' },
          cookies: anon.cookies,
          body: {},
        },
        ctx,
      )
      expect(res.status).toBe(403)
      // Safe methods are never checked.
      expect((await anon.call('GET', coll('tasks'))).status).toBe(200)
    })

    it('rejects an unparseable request body with 400 (after the XSRF check)', async () => {
      expect((await anon.call('POST', '/login', INVALID_JSON)).status).toBe(400)
    })
  })

  describe('auth endpoints', () => {
    it('AC-STUB-04: login success sets the session and returns {user}; failure is 200 {user:null}', async () => {
      const bad = await anon.call('POST', '/login', { email: CREDENTIALS.admin.email, password: 'wrong' })
      expect(bad.status).toBe(200)
      expect(body(bad)).toEqual({ user: null })
      expect(body(await anon.call('POST', '/login', { email: 'nobody@x', password: 'demo' }))).toEqual({ user: null })

      // passport-local rejects missing or empty credentials, even for a user whose stored password is empty.
      const admin = await new Client(ctx).login('admin')
      await admin.call('POST', coll('users'), {
        email: 'nopass@x',
        firstName: 'N',
        lastName: 'P',
        admin: false,
        password: '',
      })
      for (const creds of [{ email: 'nopass@x', password: '' }, { email: 'nopass@x' }, {}, undefined]) {
        expect(body(await anon.call('POST', '/login', creds)), JSON.stringify(creds)).toEqual({ user: null })
      }

      const ok = await anon.call('POST', '/login', CREDENTIALS.admin)
      expect(ok.status).toBe(200)
      expect(body(ok)).toEqual({
        user: { id: USER.admin, email: 'admin@abc.com', firstName: 'Admin', lastName: 'User', admin: true },
      })
      expect(body(await anon.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.admin } })
    })

    it('AC-STUB-05: logout is 204 with no body and clears the session user', async () => {
      const client = await new Client(ctx).login('po')
      const res = await client.call('POST', '/logout')
      expect(res).toMatchObject({ status: 204, body: null })
      expect(body(await client.call('GET', '/current-user'))).toEqual({ user: null })
    })

    it('AC-STUB-06: /current-user returns {user} when logged in and {user:null} when anonymous', async () => {
      expect(body(await anon.call('GET', '/current-user'))).toEqual({ user: null })
      const dev = await new Client(ctx).login('dev1')
      expect(body(await dev.call('GET', '/current-user'))).toEqual({
        user: { id: USER.dev1, email: 'dev1@ascrum.test', firstName: 'Dana', lastName: 'Developer', admin: false },
      })
    })
  })

  describe('collections', () => {
    it('AC-STUB-07: q supports {}, ANDed equality and _id $in of $oid; anything else is 400', async () => {
      const get = (c: string, query?: Record<string, string>) => anon.call('GET', coll(c), undefined, query)
      expect(ids(await get('projects', q({})))).toHaveLength(3)
      expect(ids(await get('projects'))).toHaveLength(3) // no q = all
      expect(ids(await get('sprints', q({ projectId: PROJECT.webshop })))).toEqual([SPRINT.webshop1, SPRINT.webshop2])
      expect(ids(await get('tasks', q({ sprintId: SPRINT.webshop1, state: 'TODO' })))).toHaveLength(2)
      expect(ids(await get('users', q({ email: 'po@ascrum.test' })))).toEqual([USER.po])
      const inQuery = q({
        _id: { $in: [{ $oid: BACKLOG.cart }, { $oid: BACKLOG.deleted }, { $oid: BACKLOG.catalogue }] },
      })
      expect(ids(await get('productbacklog', inQuery))).toEqual([BACKLOG.catalogue, BACKLOG.cart])
      expect(body(await get('productbacklog', q({ _id: { $in: [] } })))).toEqual([])

      for (const bad of [
        '{not json',
        '[]',
        '"x"',
        JSON.stringify({ $or: [] }),
        JSON.stringify({ estimation: { $gt: 3 } }),
        JSON.stringify({ _id: { $oid: BACKLOG.cart } }),
        JSON.stringify({ _id: { $in: [BACKLOG.cart] } }),
        JSON.stringify({ teamMembers: [USER.dev1] }),
        JSON.stringify({ email: 'po@ascrum.test', password: 'demo' }), // would confirm a password guess
      ]) {
        const res = await get('productbacklog', { q: bad })
        expect(res.status, bad).toBe(400)
        expect(body(res)).toHaveProperty('message')
      }
    })

    it('AC-STUB-08: GET by id returns the document, or 404 {message}', async () => {
      expect(body(await anon.call('GET', coll('projects', PROJECT.webshop)))).toMatchObject({ name: 'Webshop' })
      for (const missing of [BACKLOG.deleted, 'not-an-id', 'f'.repeat(30)]) {
        const res = await anon.call('GET', coll('projects', missing))
        expect(res.status, missing).toBe(404)
        expect(body(res)).toHaveProperty('message')
      }
    })

    it('AC-STUB-09: POST creates with a new id; PUT replaces; DELETE returns the deleted doc; missing ids are 404', async () => {
      const dev = await new Client(ctx).login('dev1')
      const created = body(
        await dev.call('POST', coll('tasks'), { name: 'New task', state: 'TODO', _id: { $oid: 'ignored' } }),
      ) as { _id: { $oid: string } }
      expect(created._id.$oid).toMatch(/^[0-9a-f]{24}$/)
      expect(created._id.$oid).not.toBe('ignored')
      const id = created._id.$oid
      expect(body(await dev.call('GET', coll('tasks', id)))).toEqual({
        _id: { $oid: id },
        name: 'New task',
        state: 'TODO',
      })

      // PUT replaces the whole document: fields left out are gone, extra fields survive.
      const put = await dev.call('PUT', coll('tasks', id), { name: 'Renamed', extra: 1 })
      expect(body(put)).toEqual({ _id: { $oid: id }, name: 'Renamed', extra: 1 })

      const del = await dev.call('DELETE', coll('tasks', id))
      expect(body(del)).toEqual({ _id: { $oid: id }, name: 'Renamed', extra: 1 })
      expect((await dev.call('GET', coll('tasks', id))).status).toBe(404)
      expect((await dev.call('PUT', coll('tasks', id), { name: 'x' })).status).toBe(404)
      expect((await dev.call('DELETE', coll('tasks', id))).status).toBe(404)
    })

    it('AC-STUB-10: anonymous writes are 401 {user:null}; non-admin writes to users/projects are 401 {user}', async () => {
      for (const [method, path] of [
        ['POST', coll('tasks')],
        ['PUT', coll('sprints', SPRINT.webshop1)],
        ['DELETE', coll('productbacklog', BACKLOG.cart)],
        ['PATCH', coll('tasks', BACKLOG.cart)], // legacy server.js: any non-GET needs a session user
        ['HEAD', coll('tasks')],
      ] as const) {
        const res = await anon.call(method, path, {})
        expect(res.status, `${method} ${path}`).toBe(401)
        expect(body(res)).toEqual({ user: null })
      }

      const po = await new Client(ctx).login('po')
      for (const path of [coll('users'), coll('projects')]) {
        const res = await po.call('POST', path, { name: 'x' })
        expect(res.status).toBe(401)
        expect(body(res)).toMatchObject({ user: { id: USER.po, admin: false } })
      }
      // Non-admin writes elsewhere are fine (D15 preserved: no project-membership check on the server).
      expect((await po.call('POST', coll('tasks'), { name: 'ok' })).status).toBe(200)
      // Admin can write users and projects.
      const admin = await new Client(ctx).login('admin')
      expect((await admin.call('POST', coll('projects'), { name: 'P' })).status).toBe(200)
    })

    it('AC-STUB-11 / D7: no response ever contains a password', async () => {
      const admin = await new Client(ctx).login('admin')
      const responses = [
        await admin.call('GET', coll('users')),
        await admin.call('GET', coll('users', USER.po)),
        await admin.call('GET', coll('users'), undefined, q({ email: 'po@ascrum.test' })),
        await admin.call('POST', coll('users'), {
          email: 'n@x',
          password: 'secret',
          firstName: 'N',
          lastName: 'X',
          admin: false,
        }),
        await admin.call('PUT', coll('users', USER.dev2), {
          email: 'dev2@ascrum.test',
          password: 'new',
          firstName: 'D',
          lastName: 'C',
        }),
        await admin.call('POST', '/login', CREDENTIALS.admin),
        await admin.call('GET', '/current-user'),
        await admin.call('DELETE', coll('users', USER.outsider)),
      ]
      for (const res of responses) {
        expect(res.status).toBe(200)
        expect(res.body).not.toMatch(/password|changeme|"demo"|secret/)
      }
    })

    it('AC-STUB-12 / S8: a users PUT without password keeps the stored one; with password replaces it', async () => {
      const admin = await new Client(ctx).login('admin')
      await admin.call('PUT', coll('users', USER.dev1), {
        email: 'dev1@ascrum.test',
        firstName: 'Dana',
        lastName: 'D',
        admin: false,
      })
      const dev = await new Client(ctx).prime()
      expect(body(await dev.call('POST', '/login', CREDENTIALS.dev1))).toMatchObject({ user: { lastName: 'D' } })

      await admin.call('PUT', coll('users', USER.dev1), {
        email: 'dev1@ascrum.test',
        password: 'changed',
        firstName: 'Dana',
        lastName: 'D',
      })
      const fresh = () => new Client(ctx).prime()
      expect(body(await (await fresh()).call('POST', '/login', CREDENTIALS.dev1))).toEqual({ user: null })
      const changed = { email: 'dev1@ascrum.test', password: 'changed' }
      expect(body(await (await fresh()).call('POST', '/login', changed))).toMatchObject({ user: { id: USER.dev1 } })
    })

    it('AC-STUB-13: an unknown database or collection is 404', async () => {
      expect((await anon.call('GET', '/databases/other/collections/users')).status).toBe(404)
      expect((await anon.call('GET', coll('widgets'))).status).toBe(404)
      expect((await anon.call('GET', coll('widgets', PROJECT.webshop))).status).toBe(404)
      const admin = await new Client(ctx).login('admin')
      expect((await admin.call('POST', coll('widgets'), {})).status).toBe(404)
      expect((await anon.call('GET', '/databases/ascrum/collections/users/a/b')).status).toBe(404)
    })
  })

  describe('reset and determinism', () => {
    it('AC-STUB-14: reset reseeds and clears sessions; with allowReset off the route does not exist', async () => {
      const admin = await new Client(ctx).login('admin')
      await admin.call('DELETE', coll('projects', PROJECT.webshop))
      expect(ids(await admin.call('GET', coll('projects')))).toHaveLength(2)

      expect(await reset(ctx)).toMatchObject({ status: 204, body: null, setCookies: [] })
      expect(ids(await admin.call('GET', coll('projects')))).toHaveLength(3)
      expect(body(await admin.call('GET', '/current-user'))).toEqual({ user: null }) // session gone

      const pages = await backend.createContext({ allowReset: false })
      const absent = await (await new Client(pages).prime()).call('POST', '/__stub/reset')
      expect(absent.status).toBe(404)
    })

    it('AC-STUB-15: after a reset, the seed and generated ids are deterministic', async () => {
      const run = async () => {
        const client = await new Client(ctx).login('dev1')
        const a = body(await client.call('POST', coll('tasks'), { name: 'a' }))
        const b = body(await client.call('POST', coll('tasks'), { name: 'b' }))
        const all = body(await client.call('GET', coll('tasks')))
        await reset(ctx)
        return { a, b, all }
      }
      const first = await run()
      expect(first.a).toEqual({ _id: { $oid: 'f00000000000000000000001' }, name: 'a' })
      expect(await run()).toEqual(first)
      // A reset store reads exactly like a brand-new one, byte for byte.
      const fresh = await backend.createContext({ allowReset: true })
      expect(await dumpCollections(ctx)).toEqual(await dumpCollections(fresh))
    })
  })

  describe('seed (spec §7.6)', () => {
    it('has the roles, the D13 partial project and dangling backlog id, and every task state', async () => {
      const projects = body(await anon.call('GET', coll('projects'))) as Record<string, unknown>[]
      expect(projects.map((p) => p.name)).toEqual(['Webshop', 'Mobile App', 'Legacy Cleanup'])
      expect(projects[2]).not.toHaveProperty('teamMembers')
      const sprint = body(await anon.call('GET', coll('sprints', SPRINT.webshop1))) as { sprintBacklog: string[] }
      expect(sprint.sprintBacklog).toContain(BACKLOG.deleted)
      expect((await anon.call('GET', coll('productbacklog', BACKLOG.deleted))).status).toBe(404)
      const tasks = body(await anon.call('GET', coll('tasks'))) as Record<string, unknown>[]
      expect(new Set(tasks.map((t) => t.state))).toEqual(new Set(['TODO', 'IN_DEV', 'BLOCKED', 'IN_TEST', 'DONE']))
      expect(tasks.some((t) => !('assignedUserId' in t))).toBe(true)
      expect(ids(await anon.call('GET', coll('tasks'), undefined, q({ sprintId: SPRINT.mobile1 })))).toEqual([])
      for (const who of Object.keys(CREDENTIALS) as (keyof typeof CREDENTIALS)[]) await new Client(ctx).login(who)
    })
  })

  // Phase 5: what the in-memory arrays did implicitly, pinned so that PostgreSQL must do the same.
  describe('store parity (Phase 5, spec §3.1)', () => {
    let admin: Client
    beforeEach(async () => {
      admin = await new Client(ctx).login('admin')
    })

    /** POST, GET, PUT, GET: every response must give back exactly what was sent. */
    const roundTrip = async (c: string, fields: Record<string, unknown>) => {
      const created = body(await admin.call('POST', coll(c), fields)) as { _id: { $oid: string } }
      const id = created._id.$oid
      expect(created).toEqual({ ...fields, _id: { $oid: id } })
      expect(body(await admin.call('GET', coll(c, id)))).toEqual({ ...fields, _id: { $oid: id } })
      const replaced = { ...fields, name: 'replaced' }
      expect(body(await admin.call('PUT', coll(c, id), replaced))).toEqual({ ...replaced, _id: { $oid: id } })
      expect(body(await admin.call('GET', coll(c, id)))).toEqual({ ...replaced, _id: { $oid: id } })
      return id
    }

    // Every collection, not only tasks (DEV-p5-store-06, owner breakage O1): each table has its own
    // SELECT, so ordering one table and not another must fail here. Editing a row is what moves it in
    // a heap without ORDER BY (or with ORDER BY ctid), so the first and a middle document are edited.
    it('DEV-p5-store-06 / O1: every collection lists in insertion order, and a PUT keeps the document in its place', async () => {
      for (const c of COLLECTIONS) {
        const docs = body(await admin.call('GET', coll(c))) as WireDoc[]
        const before = docs.map((d) => d._id.$oid)
        expect(before.length, c).toBeGreaterThanOrEqual(3)
        for (const doc of [docs[0], docs[Math.floor(docs.length / 2)]]) {
          const { _id, ...fields } = doc ?? { _id: { $oid: '' } }
          const put = await admin.call('PUT', coll(c, _id.$oid), { ...fields, name: `edited ${_id.$oid}` })
          expect(put.status, c).toBe(200)
        }
        const created = body(await admin.call('POST', coll(c), { name: 'last' })) as WireDoc
        expect(ids(await admin.call('GET', coll(c))), c).toEqual([...before, created._id.$oid])
      }
      // A filtered list keeps the same order.
      const webshopBacklog = q({ projectId: PROJECT.webshop })
      const backlog = ids(await admin.call('GET', coll('productbacklog'), undefined, webshopBacklog))
      expect(backlog).toEqual([
        BACKLOG.catalogue,
        BACKLOG.cart,
        BACKLOG.checkout,
        BACKLOG.orderHistory,
        BACKLOG.search,
        BACKLOG.wishList,
      ])
    })

    // DEV-p5-store-05 (owner breakage O2): a list field lives in a join table in PostgreSQL, so a PUT
    // that changes it must rewrite the rows and the has_* flag. Each change is read back by id and in
    // the full list, and the end state of both collections is compared whole, so a PUT that touches
    // another document's list fails too.
    it('DEV-p5-store-05 / O2: a PUT that changes a list (teamMembers, sprintBacklog) is what a re-fetch returns', async () => {
      const read = async (c: string, id: string) => body(await admin.call('GET', coll(c, id))) as WireDoc
      const without = (doc: WireDoc, field: string) =>
        Object.fromEntries(Object.entries(doc).filter(([k]) => k !== field))
      const putAndReread = async (c: string, doc: Record<string, unknown>, label: string) => {
        const id = (doc._id as { $oid: string }).$oid
        expect(body(await admin.call('PUT', coll(c, id), doc)), label).toEqual(doc)
        expect(await read(c, id), `${label}: GET by id`).toEqual(doc)
        const listed = (body(await admin.call('GET', coll(c))) as WireDoc[]).find((d) => d._id.$oid === id)
        expect(listed, `${label}: GET list`).toEqual(doc)
      }

      const webshop = await read('projects', PROJECT.webshop)
      const mobileApp = await read('projects', PROJECT.mobileApp)
      const legacyCleanup = await read('projects', PROJECT.legacyCleanup)
      expect(legacyCleanup).not.toHaveProperty('teamMembers')
      await putAndReread('projects', { ...webshop, teamMembers: [USER.dev2, USER.outsider, USER.dev1] }, 'changed')
      await putAndReread('projects', { ...webshop, teamMembers: [USER.sm] }, 'shorter')
      await putAndReread('projects', { ...legacyCleanup, teamMembers: [USER.dev1] }, 'first member (absent → present)')
      await putAndReread('projects', { ...mobileApp, teamMembers: [] }, 'cleared to []')
      await putAndReread('projects', without(webshop, 'teamMembers'), 'removed (present → absent)')
      await putAndReread('projects', { ...without(webshop, 'teamMembers'), teamMembers: [] }, 'absent → []')
      await putAndReread('projects', { ...mobileApp, teamMembers: null }, '[] → null')
      expect(body(await admin.call('GET', coll('projects')))).toEqual([
        { ...without(webshop, 'teamMembers'), teamMembers: [] },
        { ...mobileApp, teamMembers: null },
        { ...legacyCleanup, teamMembers: [USER.dev1] },
      ])

      const s1 = await read('sprints', SPRINT.webshop1)
      const s2 = await read('sprints', SPRINT.webshop2)
      const s3 = await read('sprints', SPRINT.mobile1)
      await putAndReread('sprints', { ...s1, sprintBacklog: [BACKLOG.deleted, BACKLOG.search] }, 'sprint changed')
      await putAndReread('sprints', { ...s2, sprintBacklog: [] }, 'sprint cleared')
      await putAndReread('sprints', without(s3, 'sprintBacklog'), 'sprint backlog removed')
      await putAndReread('sprints', { ...s3, sprintBacklog: [BACKLOG.push, BACKLOG.push] }, 'sprint absent → present')
      expect(body(await admin.call('GET', coll('sprints')))).toEqual([
        { ...s1, sprintBacklog: [BACKLOG.deleted, BACKLOG.search] },
        { ...s2, sprintBacklog: [] },
        { ...s3, sprintBacklog: [BACKLOG.push, BACKLOG.push] },
      ])
    })

    it('keeps every value exactly as sent: types, nulls, nesting, unknown fields, unicode', async () => {
      await roundTrip('tasks', {
        projectId: PROJECT.webshop,
        sprintId: SPRINT.webshop1,
        productBacklogItemId: BACKLOG.cart,
        name: 'Types',
        desc: null, // null is not "absent"
        estimation: '5', // a string where the schema has a number
        remaining: 2.5,
        state: 'NOT_A_STATE',
        assignedUserId: 'not-a-24-hex-id',
        tags: ['a', 1, true, null, { nested: { deep: [1, 2] } }],
        'odd key with spaces': { $oid: 'looks like an id' },
        emoji: 'Grüße 👋  ',
        big: 1e300,
        tiny: -0.000001,
      })
      await roundTrip('users', { email: 7, firstName: '', lastName: 'L', admin: 'yes' })
      await roundTrip('sprints', { projectId: PROJECT.mobileApp, name: 'S', capacity: 0, start: '', end: 'soon' })
      await roundTrip('productbacklog', { projectId: 'ABCDEF' + '0'.repeat(18), priority: 0.1 + 0.2 })
    })

    it('D13: an absent list, an empty list and a non-list value are three different things', async () => {
      const absent = await roundTrip('projects', { name: 'no team' })
      expect(body(await admin.call('GET', coll('projects', absent)))).not.toHaveProperty('teamMembers')
      await roundTrip('projects', { name: 'empty team', teamMembers: [] })
      await roundTrip('projects', { name: 'null team', teamMembers: null })
      await roundTrip('projects', { name: 'odd team', teamMembers: [USER.dev1, 42, USER.dev1] })
      await roundTrip('projects', { name: 'string team', teamMembers: USER.dev1 })
      // Duplicates and order are kept, dangling ids too.
      await roundTrip('sprints', { name: 'dup', sprintBacklog: [BACKLOG.cart, BACKLOG.deleted, BACKLOG.cart] })
      await roundTrip('sprints', { name: 'empty', sprintBacklog: [] })
    })

    it('D13: deletes never cascade or refuse; references are left dangling, as MongoDB left them', async () => {
      expect(body(await admin.call('DELETE', coll('users', USER.dev2)))).toMatchObject({ email: 'dev2@ascrum.test' })
      const webshop = body(await admin.call('GET', coll('projects', PROJECT.webshop)))
      expect(webshop).toMatchObject({ teamMembers: [USER.dev1, USER.dev2] })

      expect((await admin.call('DELETE', coll('productbacklog', BACKLOG.cart))).status).toBe(200)
      expect(body(await admin.call('GET', coll('sprints', SPRINT.webshop1)))).toMatchObject({
        sprintBacklog: [BACKLOG.catalogue, BACKLOG.cart, BACKLOG.deleted],
      })
      const cartTasks = await admin.call('GET', coll('tasks'), undefined, q({ productBacklogItemId: BACKLOG.cart }))
      expect(ids(cartTasks)).toHaveLength(4)

      expect((await admin.call('DELETE', coll('sprints', SPRINT.webshop1))).status).toBe(200)
      expect(ids(await admin.call('GET', coll('tasks'), undefined, q({ sprintId: SPRINT.webshop1 })))).toHaveLength(7)
      expect((await admin.call('DELETE', coll('projects', PROJECT.webshop))).status).toBe(200)
      const orphans = await admin.call('GET', coll('productbacklog'), undefined, q({ projectId: PROJECT.webshop }))
      expect(ids(orphans)).toHaveLength(5)
    })

    it('q equality is strict (1 is not "1") and reaches unknown fields and odd-typed values', async () => {
      const get = async (value: unknown) => ids(await admin.call('GET', coll('productbacklog'), undefined, q(value)))
      expect(await get({ priority: 1 })).toEqual([BACKLOG.catalogue, BACKLOG.login])
      expect(await get({ priority: '1' })).toEqual([])
      expect(await get({ priority: true })).toEqual([])
      const odd = body(
        await admin.call('POST', coll('productbacklog'), { priority: '1', label: 'x', flag: false, n: 2 }),
      ) as { _id: { $oid: string } }
      expect(await get({ priority: '1' })).toEqual([odd._id.$oid])
      expect(await get({ label: 'x', flag: false, n: 2 })).toEqual([odd._id.$oid])
      expect(await get({ label: 'x', flag: true })).toEqual([])
      expect(await get({ projectId: 'abc' })).toEqual([])
      expect(await get({ projectId: PROJECT.mobileApp, priority: 2 })).toEqual([BACKLOG.push])
      expect(await get({ _id: { $in: [{ $oid: 'short' }, { $oid: odd._id.$oid.toUpperCase() }] } })).toEqual([])
    })

    it('ids come from one counter shared by every collection', async () => {
      const a = body(await admin.call('POST', coll('tasks'), { name: 'a' }))
      const b = body(await admin.call('POST', coll('projects'), { name: 'b' }))
      expect([a, b]).toEqual([
        { _id: { $oid: 'f00000000000000000000001' }, name: 'a' },
        { _id: { $oid: 'f00000000000000000000002' }, name: 'b' },
      ])
    })

    it('login takes the first matching user in insertion order; deleting the signed-in user signs them out', async () => {
      const twin = body(
        await admin.call('POST', coll('users'), { email: 'po@ascrum.test', password: 'demo', firstName: 'Twin' }),
      ) as { _id: { $oid: string } }
      const po = await new Client(ctx).login('po')
      expect(body(await po.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.po } })
      await admin.call('DELETE', coll('users', USER.po))
      expect(body(await po.call('GET', '/current-user'))).toEqual({ user: null })
      const again = await (await new Client(ctx).prime()).call('POST', '/login', CREDENTIALS.po)
      expect(body(again)).toMatchObject({ user: { id: twin._id.$oid } })
    })

    // Legacy (server/lib/mongo-strategy.js findByEmail) sent q={"email": <as typed>} to MongoLab:
    // MongoDB equality, which compares strings exactly. No lower-casing or trimming anywhere on the way
    // (passport-local passes the field through). A citext column or lower() lookup would change who
    // can sign in, so both stores are held to exact matching here.
    it('DEV-p5-store-08: login matches the e-mail exactly, case included, as legacy MongoDB did', async () => {
      const tryLogin = async (email: string, password: string) => {
        const client = await new Client(ctx).prime()
        const res = body(await client.call('POST', '/login', { email, password }))
        return { res, current: body(await client.call('GET', '/current-user')) }
      }
      for (const email of ['ADMIN@ABC.COM', 'Admin@abc.com', 'admin@ABC.com', ' admin@abc.com', 'admin@abc.com ']) {
        expect(await tryLogin(email, CREDENTIALS.admin.password), email).toEqual({
          res: { user: null },
          current: { user: null },
        })
      }
      expect(body(await admin.call('GET', coll('users'), undefined, q({ email: 'ADMIN@ABC.COM' })))).toEqual([])

      await admin.call('POST', coll('users'), { email: 'Mixed@Case.test', password: 'pw', firstName: 'M' })
      expect((await tryLogin('mixed@case.test', 'pw')).res).toEqual({ user: null })
      expect((await tryLogin('Mixed@Case.test', 'pw')).res).toMatchObject({ user: { email: 'Mixed@Case.test' } })
    })

    it('DEV-p5-store-07: an e-mail that looks like SQL is only text; with a real password it signs nobody in', async () => {
      for (const email of INJECTED_EMAILS) {
        const client = await new Client(ctx).prime()
        const res = await client.call('POST', '/login', { email, password: CREDENTIALS.admin.password })
        expect(body(res), email).toEqual({ user: null })
        expect(body(await client.call('GET', '/current-user')), email).toEqual({ user: null })
      }
    })
  })
}

/** The Node adapter (real HTTP, real Set-Cookie) over a backend's store: what `pnpm stub` and the API run. */
export function defineNodeAdapterTests(backend: Backend, allowRealHttp: (base: string) => void = () => {}): void {
  let server: Server
  let base: string
  beforeAll(async () => {
    server = await startStubServer(0, await backend.createContext({ allowReset: true }))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('runs the login flow with cookies and the XSRF header', async () => {
    allowRealHttp(base)
    const jar = new Map<string, string>()
    const send = async (method: string, path: string, payload?: unknown) => {
      const headers: Record<string, string> = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
      const xsrf = jar.get('XSRF-TOKEN')
      if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
      if (payload !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(base + path, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      })
      for (const line of res.headers.getSetCookie()) {
        const [pair = ''] = line.split(';')
        const eq = pair.indexOf('=')
        jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      return res
    }
    const parse = async (res: Response): Promise<unknown> => {
      const text = await res.text()
      expect(text.startsWith(JSON_PREFIX)).toBe(true)
      return JSON.parse(text.slice(JSON_PREFIX.length)) as unknown
    }

    expect(await parse(await send('GET', '/current-user'))).toEqual({ user: null })
    expect(jar.has('sid') && jar.has('XSRF-TOKEN')).toBe(true)

    jar.set('XSRF-TOKEN', 'tampered')
    const forbidden = await send('POST', '/login', CREDENTIALS.admin)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).toBe('Forbidden')

    expect(await parse(await send('POST', '/login', CREDENTIALS.admin))).toMatchObject({ user: { admin: true } })
    expect(await parse(await send('GET', '/current-user'))).toMatchObject({ user: { email: 'admin@abc.com' } })
    expect(
      (await send('GET', `/databases/ascrum/collections/projects?q=${encodeURIComponent('{"name":"Webshop"}')}`))
        .status,
    ).toBe(200)
    expect((await send('POST', '/logout')).status).toBe(204)
    expect((await send('POST', '/__stub/reset')).status).toBe(204)
  })
}
