// AC-CTR-03: the API's health endpoint. Needs DATABASE_URL (like every integration test).
//   - 200 while the database answers, 503 when it is unreachable or does not answer in time;
//   - no session: a load balancer or Docker probes it every few seconds, and the contract's handle()
//     creates a sessions row for every request without a valid sid (DEV-p5-store-03).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createTcpServer, type Socket } from 'node:net'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { HEALTH_PATH, addHealthCheck } from './health.ts'
import { startApi } from './main.ts'
import { DATABASE_URL, emptySchema, poolFor } from './testDb.ts'

function baseOf(server: Server): string {
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function sessionRows(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM sessions')
  return Number(rows[0]?.n)
}

/** A plain server with only the health check on it, over the given pool. */
async function healthOnly(pool: pg.Pool, timeoutMs?: number): Promise<Server> {
  const server = createServer((_req, res) => res.writeHead(418).end())
  addHealthCheck(server, pool, timeoutMs)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return server
}

describe('AC-CTR-03: the API health check', () => {
  it('AC-CTR-03: /healthz answers 200 while the database is reachable, and creates no session row', async () => {
    const pool = poolFor(await emptySchema())
    const server = await startApi({ pool, port: 0, allowReset: false })
    try {
      const base = baseOf(server)
      const before = await sessionRows(pool)
      for (let i = 0; i < 5; i++) {
        const res = await fetch(base + HEALTH_PATH)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: 'ok' })
        expect(res.headers.getSetCookie()).toEqual([])
        expect(res.headers.get('cache-control')).toBe('no-store')
      }
      expect(await sessionRows(pool)).toBe(before)

      // The counter is not blind: one contract request without a cookie does create a row, and the
      // contract routes still answer through the same server.
      const anonymous = await fetch(base + '/current-user')
      expect(anonymous.status).toBe(200)
      expect(anonymous.headers.getSetCookie().length).toBeGreaterThan(0)
      expect(await sessionRows(pool)).toBe(before + 1)
    } finally {
      await close(server)
    }
  })

  it('AC-CTR-03: /healthz answers 503 when the database refuses connections', async () => {
    // Port 1 on loopback: nothing listens there, so every connection attempt is refused at once.
    const pool = new pg.Pool({ connectionString: 'postgres://nobody:unused@127.0.0.1:1/none', max: 1 })
    const server = await healthOnly(pool)
    try {
      const res = await fetch(baseOf(server) + HEALTH_PATH)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ status: 'unavailable' })
      expect(res.headers.getSetCookie()).toEqual([])
    } finally {
      await close(server)
      await pool.end()
    }
  })

  it('AC-CTR-03: /healthz answers 503 within its timeout when the database accepts but never answers', async () => {
    // A TCP server that accepts connections and never says a word: a database host that hangs.
    const sockets: Socket[] = []
    const silent = createTcpServer((socket) => sockets.push(socket))
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const port = (silent.address() as AddressInfo).port
    const pool = new pg.Pool({ connectionString: `postgres://nobody:unused@127.0.0.1:${port}/none`, max: 1 })
    const server = await healthOnly(pool, 300)
    try {
      const started = Date.now()
      const res = await fetch(baseOf(server) + HEALTH_PATH)
      expect(res.status).toBe(503)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await close(server)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
      await pool.end().catch(() => undefined)
    }
  })

  it('AC-CTR-03: the API outlives the database dropping its connections, and /healthz recovers', async () => {
    const pool = poolFor(await emptySchema())
    const server = await startApi({ pool, port: 0, allowReset: false })
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })
    try {
      const base = baseOf(server)
      expect((await fetch(base + HEALTH_PATH)).status).toBe(200)
      // What a database restart does to every idle connection. Without a pool 'error' listener this
      // is an uncaught exception, and the process (here: the test run) dies.
      const pids = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const killed = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pids.rows[0]?.pid])
      expect(killed.rows[0]?.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 200)) // let the pool see the connection die
      expect((await fetch(base + HEALTH_PATH)).status).toBe(200)
      expect((await fetch(base + '/current-user')).status).toBe(200)
    } finally {
      await close(server)
      await admin.end()
    }
  })

  it('AC-CTR-03: only GET and HEAD; other paths and methods still reach the server they were meant for', async () => {
    const pool = poolFor(await emptySchema())
    const server = await healthOnly(pool)
    try {
      const base = baseOf(server)
      expect((await fetch(base + HEALTH_PATH, { method: 'HEAD' })).status).toBe(200)
      expect((await fetch(`${base}${HEALTH_PATH}?from=probe`)).status).toBe(200)
      const post = await fetch(base + HEALTH_PATH, { method: 'POST' })
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toBe('GET, HEAD')
      // 418 is what the inner server answers: anything that is not exactly the health path passes through.
      expect((await fetch(`${base}${HEALTH_PATH}/x`)).status).toBe(418)
      expect((await fetch(`${base}/current-user`)).status).toBe(418)
    } finally {
      await close(server)
    }
  })
})
