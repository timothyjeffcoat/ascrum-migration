// The stub's whole behaviour: one async function over a store and a session table (spec §7.1).
// Adapters (server.ts for Node, msw.ts for the browser and Vitest) only translate to and from these shapes.
// Phase 5 (spec §3.1): the same function is the real API. The store and the sessions are interfaces
// (store.ts, session.ts) with in-memory and PostgreSQL implementations (api/).
//
// Legacy server facts this reproduces (inventory §9, spec §7.2/§7.3):
//   - every JSON body starts with the `)]}',\n` hijack prefix
//   - every response sets XSRF-TOKEN; unsafe methods without the matching header get 403 "Forbidden",
//     checked BEFORE auth, including /login
//   - writes need a session user (401 {user:null}); users/projects writes need admin (401 {user}), D15
//   - failed login is 200 {user:null}, not 401
import { parseQuery } from './query.ts'
import {
  getOrCreateSession,
  MemorySessions,
  SESSION_COOKIE,
  XSRF_COOKIE,
  XSRF_HEADER,
  type Sessions,
} from './session.ts'
import {
  DB_NAME,
  isCollection,
  MemoryStore,
  UnstorableValueError,
  type CollectionName,
  type Store,
  type WireDoc,
} from './store.ts'

export const JSON_PREFIX = ")]}',\n"

/** Body is already-parsed JSON (undefined when there was none); `INVALID_JSON` when parsing failed. */
export const INVALID_JSON = Symbol('invalid-json')

export type StubRequest = {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | undefined> // lower-case names
  cookies: Record<string, string>
  body: unknown
}

export type StubCookie = { name: string; value: string; httpOnly: boolean }

export type StubResponse = {
  status: number
  headers: Record<string, string>
  setCookies: StubCookie[]
  body: string | null
}

export type StubContext<S extends Store = Store, T extends Sessions = Sessions> = {
  store: S
  sessions: T
  /** POST /__stub/reset exists only in dev and tests; the Pages build turns it off (S9, AC-STUB-14). */
  allowReset: boolean
}

type CurrentUser = { id: string; email: unknown; firstName: unknown; lastName: unknown; admin: unknown }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const DATA_PATH = /^\/databases\/([^/]+)\/collections\/([^/]+)(?:\/([^/]+))?\/?$/

export async function handle(req: StubRequest, ctx: StubContext): Promise<StubResponse> {
  const method = req.method.toUpperCase()

  // Test control. Outside the legacy contract, so it skips sessions and XSRF entirely.
  if (req.path === '/__stub/reset' && ctx.allowReset) {
    if (method !== 'POST') return finish(json(404, { message: 'Not found' }), [])
    await ctx.store.reset()
    await ctx.sessions.clear()
    return finish({ status: 204, headers: {}, body: null }, [])
  }

  const { sid, session, created } = await getOrCreateSession(ctx.sessions, req.cookies[SESSION_COOKIE])
  const cookies: StubCookie[] = []
  if (created) cookies.push({ name: SESSION_COOKIE, value: sid, httpOnly: true })
  cookies.push({ name: XSRF_COOKIE, value: session.xsrf, httpOnly: false })

  // 1. XSRF (legacy xsrf.js): Express 3 `res.send(403)` sends the text "Forbidden".
  if (!SAFE_METHODS.has(method) && req.headers[XSRF_HEADER] !== session.xsrf) {
    return finish({ status: 403, headers: { 'Content-Type': 'text/plain' }, body: 'Forbidden' }, cookies)
  }
  if (req.body === INVALID_JSON) return finish(json(400, { message: 'Request body is not valid JSON' }), cookies)

  try {
    return finish(await route(method, req, { sid, userId: session.userId }, ctx), cookies)
  } catch (error) {
    // DEV-p5-store-04: PostgreSQL cannot keep a NUL character or a lone surrogate, which the in-memory
    // store accepted. Refusing the write with 400 beats storing something else than was sent.
    if (error instanceof UnstorableValueError) return finish(json(400, { message: error.message }), cookies)
    throw error
  }
}

type Reply = Omit<StubResponse, 'setCookies'>

function finish(res: Reply, setCookies: StubCookie[]): StubResponse {
  return { ...res, setCookies }
}

function json(status: number, value: unknown): Reply {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON_PREFIX + JSON.stringify(value) }
}

type Caller = { sid: string; userId: string | undefined }

async function route(method: string, req: StubRequest, caller: Caller, ctx: StubContext): Promise<Reply> {
  const { store } = ctx
  // A session whose user was deleted counts as anonymous.
  const user = caller.userId ? await store.get('users', caller.userId) : undefined

  if (req.path === '/login' && method === 'POST') {
    const creds = isRecord(req.body) ? req.body : {}
    // passport-local (legacy) fails on a missing or empty email/password before it looks anyone up.
    const valid = (v: unknown): v is string => typeof v === 'string' && v !== ''
    const match =
      valid(creds.email) && valid(creds.password)
        ? (await store.usersByEmail(creds.email)).find((u) => u.password === creds.password)
        : undefined
    if (!match) return json(200, { user: null }) // legacy: bad credentials are 200, not 401
    await ctx.sessions.setUser(caller.sid, match._id.$oid)
    return json(200, { user: currentUser(match) })
  }
  if (req.path === '/logout' && method === 'POST') {
    await ctx.sessions.setUser(caller.sid, undefined)
    return { status: 204, headers: {}, body: null }
  }
  if (req.path === '/current-user' && method === 'GET') {
    return json(200, { user: user ? currentUser(user) : null })
  }

  const data = DATA_PATH.exec(req.path)
  if (!data) return json(404, { message: 'Not found' })
  const [, db = '', collection = '', id] = data

  // 2. Auth for every non-GET method, as legacy server.js does (reads are public, D7; passwords are
  //    stripped below instead). Even HEAD and PATCH need a session user first.
  const isWrite = method !== 'GET'
  if (isWrite) {
    if (!user) return json(401, { user: null })
    if ((collection === 'users' || collection === 'projects') && user.admin !== true) {
      return json(401, { user: currentUser(user) })
    }
  }

  // 3. Routing.
  if (db !== DB_NAME || !isCollection(collection)) return json(404, { message: 'Unknown database or collection' })
  return await (id === undefined
    ? collectionRoute(method, collection, req, store)
    : documentRoute(method, collection, id, req, store))
}

async function collectionRoute(method: string, c: CollectionName, req: StubRequest, store: Store): Promise<Reply> {
  if (method === 'GET') {
    const parsed = parseQuery(req.query.q)
    if (!parsed.ok) return json(400, { message: parsed.message })
    return json(
      200,
      (await store.list(c, parsed.query)).map((doc) => publicDoc(c, doc)),
    )
  }
  if (method === 'POST') {
    if (!isRecord(req.body)) return json(400, { message: 'Expected a JSON object' })
    return json(200, publicDoc(c, await store.insert(c, req.body)))
  }
  return json(404, { message: 'Not found' })
}

async function documentRoute(
  method: string,
  c: CollectionName,
  id: string,
  req: StubRequest,
  store: Store,
): Promise<Reply> {
  const existing = await store.get(c, id)
  if (!existing) return json(404, { message: 'Document not found' })

  if (method === 'GET') return json(200, publicDoc(c, existing))
  if (method === 'PUT') {
    if (!isRecord(req.body)) return json(400, { message: 'Expected a JSON object' })
    const fields = { ...req.body }
    // S8: the edit form leaves the password blank to mean "unchanged" (owner answer A3).
    if (c === 'users' && fields.password === undefined && existing.password !== undefined) {
      fields.password = existing.password
    }
    const replaced = await store.replace(c, id, fields)
    return replaced ? json(200, publicDoc(c, replaced)) : json(404, { message: 'Document not found' })
  }
  if (method === 'DELETE') {
    const removed = await store.remove(c, id)
    return removed ? json(200, publicDoc(c, removed)) : json(404, { message: 'Document not found' })
  }
  return json(404, { message: 'Not found' })
}

/** D7 fixed: no response ever contains a password (AC-STUB-11). */
function publicDoc(c: CollectionName, doc: WireDoc): WireDoc {
  if (c !== 'users') return doc
  const copy = { ...doc }
  delete copy.password
  return copy
}

function currentUser(doc: WireDoc): CurrentUser {
  return { id: doc._id.$oid, email: doc.email, firstName: doc.firstName, lastName: doc.lastName, admin: doc.admin }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type MemoryContext = StubContext<MemoryStore, MemorySessions>

/** The in-memory stub: unit tests, `pnpm dev`, Playwright, `pnpm dev:msw` and the Pages demo. */
export function createStubContext(opts: { allowReset: boolean }): MemoryContext {
  return { store: new MemoryStore(), sessions: new MemorySessions(), allowReset: opts.allowReset }
}

/** Parses a request body the way Express's bodyParser would: empty → undefined, bad JSON → INVALID_JSON. */
export function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return INVALID_JSON
  }
}

/** Parses a Cookie header ("a=1; b=2"). */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}
