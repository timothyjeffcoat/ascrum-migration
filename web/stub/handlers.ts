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
//
// Phase 5 security (p5-security, spec §3.4), each a deliberate difference from legacy:
//   - S-p5-3 / AC-SEC-04: with a throttle in the context, too many failed sign-ins answer 429
//   - session fixation: a successful login moves the session to a new sid (the XSRF token stays,
//     Q-p5-security-2)
//   - AC-SEC-03: without allowReset, /__stub/reset is 404 before sessions and XSRF (see handle())
//   - DEV-p5-store-03: sessions expire (session.ts)
import { parseQuery } from './query.ts'
import {
  getOrCreateSession,
  MemorySessions,
  SESSION_COOKIE,
  XSRF_COOKIE,
  XSRF_HEADER,
  type Clock,
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
import { MemoryLoginThrottle, type LoginThrottle, type ThrottleLimits } from './throttle.ts'

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
  /**
   * The client's address, for per-IP login throttling. The Node adapter derives it (server.ts,
   * clientIpOf); MSW has none, and then only the per-account limit applies.
   */
  clientIp?: string
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
  /** S-p5-3: login throttling. Absent means none, as legacy (the in-memory stub's default). */
  loginThrottle?: LoginThrottle
}

type CurrentUser = { id: string; email: unknown; firstName: unknown; lastName: unknown; admin: unknown }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const DATA_PATH = /^\/databases\/([^/]+)\/collections\/([^/]+)(?:\/([^/]+))?\/?$/

export async function handle(req: StubRequest, ctx: StubContext): Promise<StubResponse> {
  const method = req.method.toUpperCase()

  // Test control. Outside the legacy contract, so it skips sessions and XSRF entirely.
  // AC-SEC-03: when the route is off (production, the Pages build) the path is answered 404 here too,
  // before a session is created or XSRF is checked. Wave A found it answered 403 to a request without
  // the header, because XSRF ran first. The XSRF rule guards state-changing routes; a route that does not
  // exist changes nothing, and answering 404 for exactly this path, with no session and no cookie, tells
  // a scanner only that the route is absent. Every real route, and every other unknown path, still
  // checks XSRF first (AC-STUB-03).
  if (req.path === '/__stub/reset') {
    if (!ctx.allowReset || method !== 'POST') return finish(json(404, { message: 'Not found' }), [])
    await ctx.store.reset()
    await ctx.sessions.clear()
    await ctx.loginThrottle?.clear()
    return finish({ status: 204, headers: {}, body: null }, [])
  }

  const { sid, session, created } = await getOrCreateSession(ctx.sessions, req.cookies[SESSION_COOKIE])
  const cookies = sessionCookies(sid, session.xsrf, created)

  // 1. XSRF (legacy xsrf.js): Express 3 `res.send(403)` sends the text "Forbidden".
  if (!SAFE_METHODS.has(method) && req.headers[XSRF_HEADER] !== session.xsrf) {
    return finish({ status: 403, headers: { 'Content-Type': 'text/plain' }, body: 'Forbidden' }, cookies)
  }
  if (req.body === INVALID_JSON) return finish(json(400, { message: 'Request body is not valid JSON' }), cookies)

  try {
    const caller: Caller = { sid, userId: session.userId }
    const reply = await route(method, req, caller, ctx)
    // Login rotated the session: the response carries the new sid.
    const sent = caller.rotatedTo ? sessionCookies(caller.rotatedTo, session.xsrf, true) : cookies
    return finish(reply, sent)
  } catch (error) {
    // DEV-p5-store-04: PostgreSQL cannot keep a NUL character or a lone surrogate, which the in-memory
    // store accepted. Refusing the write with 400 beats storing something else than was sent.
    if (error instanceof UnstorableValueError) return finish(json(400, { message: error.message }), cookies)
    throw error
  }
}

type Reply = Omit<StubResponse, 'setCookies'>

function sessionCookies(sid: string, xsrf: string, newSid: boolean): StubCookie[] {
  const cookies: StubCookie[] = []
  if (newSid) cookies.push({ name: SESSION_COOKIE, value: sid, httpOnly: true })
  cookies.push({ name: XSRF_COOKIE, value: xsrf, httpOnly: false })
  return cookies
}

function finish(res: Reply, setCookies: StubCookie[]): StubResponse {
  return { ...res, setCookies }
}

function json(status: number, value: unknown): Reply {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON_PREFIX + JSON.stringify(value) }
}

type Caller = {
  sid: string
  userId: string | undefined
  /** Set by a successful login: the sid the session now has. */
  rotatedTo?: string
}

const TOO_MANY = 'Too many failed sign-ins. Try again later.'

async function route(method: string, req: StubRequest, caller: Caller, ctx: StubContext): Promise<Reply> {
  const { store } = ctx
  // A session whose user was deleted counts as anonymous.
  const user = caller.userId ? await store.get('users', caller.userId) : undefined

  if (req.path === '/login' && method === 'POST') {
    const creds = isRecord(req.body) ? req.body : {}
    const attempt = { account: typeof creds.email === 'string' ? creds.email : undefined, ip: req.clientIp }
    // S-p5-3 / AC-SEC-04: a blocked account or address is refused before any password is checked
    // (which also spares the scrypt work). 429 is Q-p5-10 (b); the front end shows serverError (S14).
    // DEV-p5-security-08: admit() counts this attempt as a failure *now*, before the check, so attempts
    // sent at once cannot all see "under the limit". If the check throws, the count stays (fail closed:
    // we cannot tell whether the password was compared).
    const admission = await ctx.loginThrottle?.admit(attempt)
    if (admission && !admission.allowed) {
      const reply = json(429, { message: TOO_MANY })
      return { ...reply, headers: { ...reply.headers, 'Retry-After': String(admission.retryAfter) } }
    }
    // passport-local (legacy) fails on a missing or empty email/password before it looks anyone up.
    const valid = (v: unknown): v is string => typeof v === 'string' && v !== ''
    const match =
      valid(creds.email) && valid(creds.password) ? await store.findLogin(creds.email, creds.password) : undefined
    if (!match) return json(200, { user: null }) // legacy: bad credentials are 200, not 401; already counted
    if (admission) await ctx.loginThrottle?.succeeded(admission.reservation)
    // Session fixation: the signed-in session gets a new sid, and the pre-login sid (which an attacker
    // could have planted or read before sign-in) stops existing. Legacy kept the same session.
    // The XSRF token is kept: a new one would be visible to the front end (src/api/http.test.ts,
    // AC-API-07, pins it), so it is kept (Q-p5-security-2, answered (a)).
    caller.rotatedTo = await ctx.sessions.rotate(caller.sid)
    await ctx.sessions.setUser(caller.rotatedTo, match._id.$oid)
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
    // S8 (a users PUT without password keeps the stored one) is the store's job: PgStore keeps only a
    // hash, which must not be fed back in as if it were a new password (S-p5-1).
    const replaced = await store.replace(c, id, req.body)
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

export type StubContextOptions = {
  allowReset: boolean
  /** Login throttling; the stub runs without it (as legacy) unless a test asks for it. */
  throttle?: ThrottleLimits
  sessionIdleSeconds?: number
  clock?: Clock
}

/** The in-memory stub: unit tests, `pnpm dev`, Playwright, `pnpm dev:msw` and the Pages demo. */
export function createStubContext(opts: StubContextOptions): MemoryContext {
  const clock = opts.clock ?? Date.now
  return {
    store: new MemoryStore(),
    sessions: new MemorySessions({ idleSeconds: opts.sessionIdleSeconds, clock }),
    allowReset: opts.allowReset,
    ...(opts.throttle ? { loginThrottle: new MemoryLoginThrottle(opts.throttle, clock) } : {}),
  }
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
