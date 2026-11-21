// Contract tests for the stub core (spec §7.5, AC-STUB-01..15). They call handle() directly;
// adapters.test.ts proves the same behaviour survives real HTTP and MSW.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createStubContext,
  handle,
  INVALID_JSON,
  JSON_PREFIX,
  type StubContext,
  type StubResponse,
} from './handlers.ts'
import { BACKLOG, CREDENTIALS, PROJECT, SPRINT, USER } from './seed.ts'

/** A tiny browser: keeps cookies between calls and sends X-XSRF-TOKEN like AngularJS $http did. */
class Client {
  cookies: Record<string, string> = {}
  sendXsrf = true
  readonly ctx: StubContext
  constructor(ctx: StubContext) {
    this.ctx = ctx
  }

  call(method: string, path: string, body?: unknown, query: Record<string, string> = {}): StubResponse {
    const headers: Record<string, string | undefined> = {}
    if (this.sendXsrf && this.cookies['XSRF-TOKEN']) headers['x-xsrf-token'] = this.cookies['XSRF-TOKEN']
    const res = handle({ method, path, query, headers, cookies: { ...this.cookies }, body }, this.ctx)
    for (const c of res.setCookies) this.cookies[c.name] = c.value
    return res
  }

  /** First GET, so the client holds an XSRF token, as a browser would after loading the app. */
  prime(): this {
    this.call('GET', '/current-user')
    return this
  }

  login(who: keyof typeof CREDENTIALS): this {
    this.prime()
    const res = this.call('POST', '/login', CREDENTIALS[who])
    expect(body(res)).toMatchObject({ user: { email: CREDENTIALS[who].email } })
    return this
  }
}

function body(res: StubResponse): unknown {
  expect(res.body?.startsWith(JSON_PREFIX)).toBe(true)
  return JSON.parse((res.body ?? '').slice(JSON_PREFIX.length)) as unknown
}

const coll = (c: string, id?: string) => `/databases/ascrum/collections/${c}${id ? `/${id}` : ''}`
const q = (value: unknown) => ({ q: JSON.stringify(value) })
const ids = (res: StubResponse) => (body(res) as { _id: { $oid: string } }[]).map((d) => d._id.$oid)

let ctx: StubContext
let anon: Client
beforeEach(() => {
  ctx = createStubContext({ allowReset: true })
  anon = new Client(ctx).prime()
})

describe('transport', () => {
  it("AC-STUB-01: JSON responses carry the )]}', prefix and a JSON content type", () => {
    const res = anon.call('GET', coll('projects'))
    expect(res.headers['Content-Type']).toBe('application/json')
    expect(res.body?.startsWith(")]}',\n")).toBe(true)
    expect(body(res)).toHaveLength(3)
  })

  it('AC-STUB-02: XSRF-TOKEN is set on every response and stable within a session', () => {
    const first = anon.cookies['XSRF-TOKEN']
    expect(first).toBeTruthy()
    for (const res of [anon.call('GET', coll('users')), anon.call('POST', '/logout'), anon.call('GET', '/nope')]) {
      expect(res.setCookies.find((c) => c.name === 'XSRF-TOKEN')?.value).toBe(first)
    }
    const other = new Client(ctx).prime()
    expect(other.cookies['XSRF-TOKEN']).not.toBe(first)
  })

  it('AC-STUB-03: an unsafe method without the matching header is 403 "Forbidden", before auth, including /login', () => {
    anon.sendXsrf = false
    const login = anon.call('POST', '/login', CREDENTIALS.admin)
    expect(login).toMatchObject({ status: 403, body: 'Forbidden', headers: { 'Content-Type': 'text/plain' } })
    // Anonymous write: XSRF (403) wins over auth (401).
    expect(anon.call('POST', coll('tasks'), { name: 'x' }).status).toBe(403)
    // A wrong token is as bad as none.
    const res = handle(
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
    expect(anon.call('GET', coll('tasks')).status).toBe(200)
  })

  it('rejects an unparseable request body with 400 (after the XSRF check)', () => {
    expect(anon.call('POST', '/login', INVALID_JSON).status).toBe(400)
  })
})

describe('auth endpoints', () => {
  it('AC-STUB-04: login success sets the session and returns {user}; failure is 200 {user:null}', () => {
    const bad = anon.call('POST', '/login', { email: CREDENTIALS.admin.email, password: 'wrong' })
    expect(bad.status).toBe(200)
    expect(body(bad)).toEqual({ user: null })
    expect(body(anon.call('POST', '/login', { email: 'nobody@x', password: 'demo' }))).toEqual({ user: null })

    // passport-local rejects missing or empty credentials, even for a user whose stored password is empty.
    const admin = new Client(ctx).login('admin')
    admin.call('POST', coll('users'), { email: 'nopass@x', firstName: 'N', lastName: 'P', admin: false, password: '' })
    for (const creds of [{ email: 'nopass@x', password: '' }, { email: 'nopass@x' }, {}, undefined]) {
      expect(body(anon.call('POST', '/login', creds)), JSON.stringify(creds)).toEqual({ user: null })
    }

    const ok = anon.call('POST', '/login', CREDENTIALS.admin)
    expect(ok.status).toBe(200)
    expect(body(ok)).toEqual({
      user: { id: USER.admin, email: 'admin@abc.com', firstName: 'Admin', lastName: 'User', admin: true },
    })
    expect(body(anon.call('GET', '/current-user'))).toMatchObject({ user: { id: USER.admin } })
  })

  it('AC-STUB-05: logout is 204 with no body and clears the session user', () => {
    const client = new Client(ctx).login('po')
    const res = client.call('POST', '/logout')
    expect(res).toMatchObject({ status: 204, body: null })
    expect(body(client.call('GET', '/current-user'))).toEqual({ user: null })
  })

  it('AC-STUB-06: /current-user returns {user} when logged in and {user:null} when anonymous', () => {
    expect(body(anon.call('GET', '/current-user'))).toEqual({ user: null })
    const dev = new Client(ctx).login('dev1')
    expect(body(dev.call('GET', '/current-user'))).toEqual({
      user: { id: USER.dev1, email: 'dev1@ascrum.test', firstName: 'Dana', lastName: 'Developer', admin: false },
    })
  })
})

describe('collections', () => {
  it('AC-STUB-07: q supports {}, ANDed equality and _id $in of $oid; anything else is 400', () => {
    expect(ids(anon.call('GET', coll('projects'), undefined, q({})))).toHaveLength(3)
    expect(ids(anon.call('GET', coll('projects')))).toHaveLength(3) // no q = all
    expect(ids(anon.call('GET', coll('sprints'), undefined, q({ projectId: PROJECT.webshop })))).toEqual([
      SPRINT.webshop1,
      SPRINT.webshop2,
    ])
    const and = anon.call('GET', coll('tasks'), undefined, q({ sprintId: SPRINT.webshop1, state: 'TODO' }))
    expect(ids(and)).toHaveLength(2)
    expect(ids(anon.call('GET', coll('users'), undefined, q({ email: 'po@ascrum.test' })))).toEqual([USER.po])
    const inQuery = q({
      _id: { $in: [{ $oid: BACKLOG.cart }, { $oid: BACKLOG.deleted }, { $oid: BACKLOG.catalogue }] },
    })
    expect(ids(anon.call('GET', coll('productbacklog'), undefined, inQuery))).toEqual([BACKLOG.catalogue, BACKLOG.cart])
    expect(body(anon.call('GET', coll('productbacklog'), undefined, q({ _id: { $in: [] } })))).toEqual([])

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
      const res = anon.call('GET', coll('productbacklog'), undefined, { q: bad })
      expect(res.status, bad).toBe(400)
      expect(body(res)).toHaveProperty('message')
    }
  })

  it('AC-STUB-08: GET by id returns the document, or 404 {message}', () => {
    expect(body(anon.call('GET', coll('projects', PROJECT.webshop)))).toMatchObject({ name: 'Webshop' })
    const missing = anon.call('GET', coll('projects', BACKLOG.deleted))
    expect(missing.status).toBe(404)
    expect(body(missing)).toHaveProperty('message')
  })

  it('AC-STUB-09: POST creates with a new id; PUT replaces; DELETE returns the deleted doc; missing ids are 404', () => {
    const dev = new Client(ctx).login('dev1')
    const created = body(
      dev.call('POST', coll('tasks'), { name: 'New task', state: 'TODO', _id: { $oid: 'ignored' } }),
    ) as {
      _id: { $oid: string }
    }
    expect(created._id.$oid).toMatch(/^[0-9a-f]{24}$/)
    expect(created._id.$oid).not.toBe('ignored')
    const id = created._id.$oid
    expect(body(dev.call('GET', coll('tasks', id)))).toEqual({ _id: { $oid: id }, name: 'New task', state: 'TODO' })

    // PUT replaces the whole document: fields left out are gone, extra fields survive.
    const put = dev.call('PUT', coll('tasks', id), { name: 'Renamed', extra: 1 })
    expect(body(put)).toEqual({ _id: { $oid: id }, name: 'Renamed', extra: 1 })

    const del = dev.call('DELETE', coll('tasks', id))
    expect(body(del)).toEqual({ _id: { $oid: id }, name: 'Renamed', extra: 1 })
    expect(dev.call('GET', coll('tasks', id)).status).toBe(404)
    expect(dev.call('PUT', coll('tasks', id), { name: 'x' }).status).toBe(404)
    expect(dev.call('DELETE', coll('tasks', id)).status).toBe(404)
  })

  it('AC-STUB-10: anonymous writes are 401 {user:null}; non-admin writes to users/projects are 401 {user}', () => {
    for (const [method, path] of [
      ['POST', coll('tasks')],
      ['PUT', coll('sprints', SPRINT.webshop1)],
      ['DELETE', coll('productbacklog', BACKLOG.cart)],
      ['PATCH', coll('tasks', BACKLOG.cart)], // legacy server.js: any non-GET needs a session user
      ['HEAD', coll('tasks')],
    ] as const) {
      const res = anon.call(method, path, {})
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(body(res)).toEqual({ user: null })
    }

    const po = new Client(ctx).login('po')
    for (const path of [coll('users'), coll('projects')]) {
      const res = po.call('POST', path, { name: 'x' })
      expect(res.status).toBe(401)
      expect(body(res)).toMatchObject({ user: { id: USER.po, admin: false } })
    }
    // Non-admin writes elsewhere are fine (D15 preserved: no project-membership check on the server).
    expect(po.call('POST', coll('tasks'), { name: 'ok' }).status).toBe(200)
    // Admin can write users and projects.
    expect(new Client(ctx).login('admin').call('POST', coll('projects'), { name: 'P' }).status).toBe(200)
  })

  it('AC-STUB-11 / D7: no response ever contains a password', () => {
    const admin = new Client(ctx).login('admin')
    const responses = [
      admin.call('GET', coll('users')),
      admin.call('GET', coll('users', USER.po)),
      admin.call('GET', coll('users'), undefined, q({ email: 'po@ascrum.test' })),
      admin.call('POST', coll('users'), {
        email: 'n@x',
        password: 'secret',
        firstName: 'N',
        lastName: 'X',
        admin: false,
      }),
      admin.call('PUT', coll('users', USER.dev2), {
        email: 'dev2@ascrum.test',
        password: 'new',
        firstName: 'D',
        lastName: 'C',
      }),
      admin.call('POST', '/login', CREDENTIALS.admin),
      admin.call('GET', '/current-user'),
      admin.call('DELETE', coll('users', USER.outsider)),
    ]
    for (const res of responses) {
      expect(res.status).toBe(200)
      expect(res.body).not.toMatch(/password|changeme|"demo"|secret/)
    }
  })

  it('AC-STUB-12 / S8: a users PUT without password keeps the stored one; with password replaces it', () => {
    const admin = new Client(ctx).login('admin')
    admin.call('PUT', coll('users', USER.dev1), {
      email: 'dev1@ascrum.test',
      firstName: 'Dana',
      lastName: 'D',
      admin: false,
    })
    const dev = new Client(ctx).prime()
    expect(body(dev.call('POST', '/login', CREDENTIALS.dev1))).toMatchObject({ user: { lastName: 'D' } })

    admin.call('PUT', coll('users', USER.dev1), {
      email: 'dev1@ascrum.test',
      password: 'changed',
      firstName: 'Dana',
      lastName: 'D',
    })
    expect(body(new Client(ctx).prime().call('POST', '/login', CREDENTIALS.dev1))).toEqual({ user: null })
    expect(
      body(new Client(ctx).prime().call('POST', '/login', { email: 'dev1@ascrum.test', password: 'changed' })),
    ).toMatchObject({
      user: { id: USER.dev1 },
    })
  })

  it('AC-STUB-13: an unknown database or collection is 404', () => {
    expect(anon.call('GET', '/databases/other/collections/users').status).toBe(404)
    expect(anon.call('GET', coll('widgets')).status).toBe(404)
    expect(anon.call('GET', coll('widgets', PROJECT.webshop)).status).toBe(404)
    expect(new Client(ctx).login('admin').call('POST', coll('widgets'), {}).status).toBe(404)
    expect(anon.call('GET', '/databases/ascrum/collections/users/a/b').status).toBe(404)
  })
})

describe('reset and determinism', () => {
  it('AC-STUB-14: reset reseeds and clears sessions; with allowReset off the route does not exist', () => {
    const admin = new Client(ctx).login('admin')
    admin.call('DELETE', coll('projects', PROJECT.webshop))
    expect(ids(admin.call('GET', coll('projects')))).toHaveLength(2)

    const reset = handle(
      { method: 'POST', path: '/__stub/reset', query: {}, headers: {}, cookies: {}, body: undefined },
      ctx,
    )
    expect(reset).toMatchObject({ status: 204, body: null, setCookies: [] })
    expect(ids(admin.call('GET', coll('projects')))).toHaveLength(3)
    expect(body(admin.call('GET', '/current-user'))).toEqual({ user: null }) // session gone

    const pages = createStubContext({ allowReset: false })
    const absent = new Client(pages).prime().call('POST', '/__stub/reset')
    expect(absent.status).toBe(404)
  })

  it('AC-STUB-15: after a reset, the seed and generated ids are deterministic', () => {
    const run = () => {
      const client = new Client(ctx).login('dev1')
      const a = body(client.call('POST', coll('tasks'), { name: 'a' }))
      const b = body(client.call('POST', coll('tasks'), { name: 'b' }))
      const all = body(client.call('GET', coll('tasks')))
      handle({ method: 'POST', path: '/__stub/reset', query: {}, headers: {}, cookies: {}, body: undefined }, ctx)
      return { a, b, all }
    }
    const first = run()
    expect(first.a).toEqual({ _id: { $oid: 'f00000000000000000000001' }, name: 'a' })
    expect(run()).toEqual(first)
    expect(createStubContext({ allowReset: true }).store).toEqual(ctx.store)
  })
})

describe('seed (spec §7.6)', () => {
  it('has the roles, the D13 partial project and dangling backlog id, and every task state', () => {
    const projects = body(anon.call('GET', coll('projects'))) as Record<string, unknown>[]
    expect(projects.map((p) => p.name)).toEqual(['Webshop', 'Mobile App', 'Legacy Cleanup'])
    expect(projects[2]).not.toHaveProperty('teamMembers')
    const sprint = body(anon.call('GET', coll('sprints', SPRINT.webshop1))) as { sprintBacklog: string[] }
    expect(sprint.sprintBacklog).toContain(BACKLOG.deleted)
    expect(anon.call('GET', coll('productbacklog', BACKLOG.deleted)).status).toBe(404)
    const tasks = body(anon.call('GET', coll('tasks'))) as Record<string, unknown>[]
    expect(new Set(tasks.map((t) => t.state))).toEqual(new Set(['TODO', 'IN_DEV', 'BLOCKED', 'IN_TEST', 'DONE']))
    expect(tasks.some((t) => !('assignedUserId' in t))).toBe(true)
    expect(ids(anon.call('GET', coll('tasks'), undefined, q({ sprintId: SPRINT.mobile1 })))).toEqual([])
    for (const who of Object.keys(CREDENTIALS) as (keyof typeof CREDENTIALS)[]) new Client(ctx).login(who)
  })
})
