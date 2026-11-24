// AC-CTR-03: GET /healthz, the API's health check, for Docker's HEALTHCHECK, compose's depends_on and,
// in wave C, the load balancer's target health check.
//
// - 200 {"status":"ok"} when `SELECT 1` succeeds within the timeout; 503 {"status":"unavailable"} when
//   the database refuses, fails or does not answer in time. A health check that cannot reach the
//   database is the signal the orchestrator needs; the API itself stays up and recovers by itself.
// - It runs **before** the contract's handle(), so a probe never creates a session row and never gets
//   a cookie. handle() opens a session for every request without a valid sid (DEV-p5-store-03); a
//   probe every few seconds would otherwise add thousands of rows a day.
//
// Why /healthz cannot clash with the wire contract: handle() routes only /login, /logout,
// /current-user, /databases/:db/collections/:collection[/:id] and (with ALLOW_RESET) /__stub/reset;
// every other path is a 404 there, and the legacy server served index.html for it. The path matched
// here is exactly /healthz (a query string allowed), so no contract path ever reaches this code. And
// the web origin routes only the contract's paths to the API (spec §3.6), so /healthz is not
// reachable through the public origin at all: only from inside the network (Docker, the load balancer).
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type pg from 'pg'

export const HEALTH_PATH = '/healthz'
const DEFAULT_TIMEOUT_MS = 2000

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

/** True when the database answers `SELECT 1` within `timeoutMs`. Never throws. */
export async function databaseAnswers(pool: pg.Pool, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([pool.query('SELECT 1'), timeout])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Puts the health check in front of the server's existing request listener.
 *
 * The contract's Node adapter (web/stub/server.ts, shared with the stub and not this cluster's file)
 * creates its server with one request listener and offers no hook. So this takes that listener off the
 * server and puts a dispatcher in its place: exactly /healthz is answered here, everything else goes
 * to the original listener unchanged. Call it right after the server starts listening, before the
 * event loop turns, so no request can arrive in between (startApi does).
 */
export function addHealthCheck(server: Server, pool: pg.Pool, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  // The pool's 'error' listener, which keeps the process alive when the database drops its connections,
  // is startApi()'s (main.ts, Q-p5-containers-1 (b)): process survival does not depend on this module.
  const contract = server.listeners('request') as RequestListener[]
  server.removeAllListeners('request')
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? '/', 'http://api.local').pathname !== HEALTH_PATH) {
      for (const listener of contract) listener.call(server, req, res)
      return
    }
    void answer(req, res, pool, timeoutMs)
  })
}

async function answer(req: IncomingMessage, res: ServerResponse, pool: pg.Pool, timeoutMs: number): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  const ok = await databaseAnswers(pool, timeoutMs)
  const body = JSON.stringify({ status: ok ? 'ok' : 'unavailable' })
  res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
}
