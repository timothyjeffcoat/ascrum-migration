// AC-PG-06: sessions survive an API restart. Needs DATABASE_URL.
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { JSON_PREFIX } from '../../web/stub/handlers.ts'
import { CREDENTIALS, USER } from '../../web/stub/seed.ts'
import { startApi } from './main.ts'
import { emptySchema, poolFor } from './testDb.ts'

/** A browser's cookie jar and XSRF header, kept across API processes. */
function browser() {
  const jar = new Map<string, string>()
  return async (base: string, method: string, path: string, payload?: unknown) => {
    const headers: Record<string, string> = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
    const xsrf = jar.get('XSRF-TOKEN')
    if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
    const res = await fetch(base + path, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
    }
    const text = await res.text()
    return {
      status: res.status,
      json: text.startsWith(JSON_PREFIX) ? JSON.parse(text.slice(JSON_PREFIX.length)) : text,
    }
  }
}

async function start(schema: string): Promise<{ server: Server; base: string; stop: () => Promise<void> }> {
  const pool = poolFor(schema)
  const server = await startApi({ pool, port: 0, allowReset: false })
  return {
    server,
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    // A real restart: close the server and every database connection, keep nothing in memory.
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.end()
    },
  }
}

describe('AC-PG-06: sessions in PostgreSQL', () => {
  it('AC-PG-06: a signed-in session, its XSRF token and the data survive an API restart', async () => {
    const schema = await emptySchema()
    const send = browser()

    const first = await start(schema) // a brand-new database: migrates and seeds
    expect((await send(first.base, 'GET', '/current-user')).json).toEqual({ user: null })
    expect((await send(first.base, 'POST', '/login', CREDENTIALS.po)).json).toMatchObject({ user: { id: USER.po } })
    const created = await send(first.base, 'POST', '/databases/ascrum/collections/tasks', { name: 'before restart' })
    expect(created.status).toBe(200)
    await first.stop()

    const second = await start(schema) // same database: nothing to migrate, no reseed
    expect((await send(second.base, 'GET', '/current-user')).json).toMatchObject({ user: { id: USER.po } })
    // The XSRF token from before the restart still works for a write.
    const after = await send(second.base, 'POST', '/databases/ascrum/collections/tasks', { name: 'after restart' })
    expect(after.status).toBe(200)
    const tasks = (await send(second.base, 'GET', '/databases/ascrum/collections/tasks')).json as { name: string }[]
    expect(tasks.map((t) => t.name).slice(-2)).toEqual(['before restart', 'after restart'])
    // Without ALLOW_RESET there is no reset route (spec §3.3).
    expect((await send(second.base, 'POST', '/__stub/reset')).status).toBe(404)
    await second.stop()
  })
})
