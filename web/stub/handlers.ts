// The stub's whole behaviour: one pure-ish function over a store and a session table (spec §7.1).
// Adapters (server.ts for Node, msw.ts for the browser and Vitest) only translate to and from these shapes.
//
// Legacy server facts this reproduces (inventory §9, spec §7.2/§7.3):
//   - every JSON body starts with the `)]}',\n` hijack prefix
//   - every response sets XSRF-TOKEN; unsafe methods without the matching header get 403 "Forbidden",
//     checked BEFORE auth, including /login
//   - writes need a session user (401 {user:null}); users/projects writes need admin (401 {user}), D15
//   - failed login is 200 {user:null}, not 401
import { parseQuery } from './query.ts'
import {
  createSessions,
  getOrCreateSession,
  SESSION_COOKIE,
  XSRF_COOKIE,
  XSRF_HEADER,
  type Session,
  type Sessions,
} from './session.ts'
import {
  createStore,
  DB_NAME,
  findById,
  isCollection,
  newId,
  resetStore,
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

export type StubContext = {
  store: Store
  sessions: Sessions
  /** POST /__stub/reset exists only in dev and tests; the Pages build turns it off (S9, AC-STUB-14). */
  allowReset: boolean
}

type CurrentUser = { id: string; email: unknown; firstName: unknown; lastName: unknown; admin: unknown }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const DATA_PATH = /^\/databases\/([^/]+)\/collections\/([^/]+)(?:\/([^/]+))?\/?$/

export function handle(req: StubRequest, ctx: StubContext): StubResponse {
  const method = req.method.toUpperCase()

  // Test control. Outside the legacy contract, so it skips sessions and XSRF entirely.
  if (req.path === '/__stub/reset' && ctx.allowReset) {
    if (method !== 'POST') return finish(json(404, { message: 'Not found' }), [])
    resetStore(ctx.store)
    ctx.sessions.clear()
    return finish({ status: 204, headers: {}, body: null }, [])
  }

  const { sid, session, created } = getOrCreateSession(ctx.sessions, req.cookies[SESSION_COOKIE])
  const cookies: StubCookie[] = []
  if (created) cookies.push({ name: SESSION_COOKIE, value: sid, httpOnly: true })
  cookies.push({ name: XSRF_COOKIE, value: session.xsrf, httpOnly: false })

  // 1. XSRF (legacy xsrf.js): Express 3 `res.send(403)` sends the text "Forbidden".
  if (!SAFE_METHODS.has(method) && req.headers[XSRF_HEADER] !== session.xsrf) {
    return finish({ status: 403, headers: { 'Content-Type': 'text/plain' }, body: 'Forbidden' }, cookies)
  }
  if (req.body === INVALID_JSON) return finish(json(400, { message: 'Request body is not valid JSON' }), cookies)

  return finish(route(method, req, session, ctx), cookies)
}

type Reply = Omit<StubResponse, 'setCookies'>

function finish(res: Reply, setCookies: StubCookie[]): StubResponse {
  return { ...res, setCookies }
}

function json(status: number, value: unknown): Reply {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON_PREFIX + JSON.stringify(value) }
}

function route(method: string, req: StubRequest, session: Session, ctx: StubContext): Reply {
  const { store } = ctx
  const user = session.userId ? findById(store, 'users', session.userId) : undefined

  if (req.path === '/login' && method === 'POST') {
    const creds = isRecord(req.body) ? req.body : {}
    const match = store.collections.users.find(
      (u) => typeof creds.email === 'string' && u.email === creds.email && u.password === creds.password,
    )
    if (!match) return json(200, { user: null }) // legacy: bad credentials are 200, not 401
    session.userId = match._id.$oid
    return json(200, { user: currentUser(match) })
  }
  if (req.path === '/logout' && method === 'POST') {
    delete session.userId
    return { status: 204, headers: {}, body: null }
  }
  if (req.path === '/current-user' && method === 'GET') {
    return json(200, { user: user ? currentUser(user) : null })
  }

  const data = DATA_PATH.exec(req.path)
  if (!data) return json(404, { message: 'Not found' })
  const [, db = '', collection = '', id] = data

  // 2. Auth, for writes only (reads are public in legacy, D7; passwords are stripped below instead).
  const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE'
  if (isWrite) {
    if (!user) return json(401, { user: null })
    if ((collection === 'users' || collection === 'projects') && user.admin !== true) {
      return json(401, { user: currentUser(user) })
    }
  }

  // 3. Routing.
  if (db !== DB_NAME || !isCollection(collection)) return json(404, { message: 'Unknown database or collection' })
  return id === undefined
    ? collectionRoute(method, collection, req, store)
    : documentRoute(method, collection, id, req, store)
}

function collectionRoute(method: string, c: CollectionName, req: StubRequest, store: Store): Reply {
  if (method === 'GET') {
    const query = parseQuery(req.query.q)
    if (!query.ok) return json(400, { message: query.message })
    return json(
      200,
      store.collections[c].filter(query.match).map((doc) => publicDoc(c, doc)),
    )
  }
  if (method === 'POST') {
    if (!isRecord(req.body)) return json(400, { message: 'Expected a JSON object' })
    const created: WireDoc = { ...clone(req.body), _id: { $oid: newId(store) } }
    store.collections[c].push(created)
    return json(200, publicDoc(c, created))
  }
  return json(404, { message: 'Not found' })
}

function documentRoute(method: string, c: CollectionName, id: string, req: StubRequest, store: Store): Reply {
  const docs = store.collections[c]
  const index = docs.findIndex((doc) => doc._id.$oid === id)
  const existing = docs[index]
  if (!existing) return json(404, { message: 'Document not found' })

  if (method === 'GET') return json(200, publicDoc(c, existing))
  if (method === 'PUT') {
    if (!isRecord(req.body)) return json(400, { message: 'Expected a JSON object' })
    const replacement: WireDoc = { ...clone(req.body), _id: { $oid: id } }
    // S8: the edit form leaves the password blank to mean "unchanged" (owner answer A3).
    if (c === 'users' && replacement.password === undefined && existing.password !== undefined) {
      replacement.password = existing.password
    }
    docs[index] = replacement
    return json(200, publicDoc(c, replacement))
  }
  if (method === 'DELETE') {
    docs.splice(index, 1)
    return json(200, publicDoc(c, existing))
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

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createStubContext(opts: { allowReset: boolean }): StubContext {
  return { store: createStore(), sessions: createSessions(), allowReset: opts.allowReset }
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
