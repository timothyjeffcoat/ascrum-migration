// The adapters must not change behaviour: the same flows over real HTTP (Node adapter) and through
// fetch + MSW in jsdom (the setup every component test uses). Also covers the src/test/ helpers.
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { http, passthrough } from 'msw'
import { server as mswServer } from '../src/test/server.ts'
import { failNext, resetStub } from '../src/test/stubControl.ts'
import { JSON_PREFIX } from './handlers.ts'
import { CREDENTIALS, PROJECT } from './seed.ts'
import { startStubServer } from './server.ts'

const parse = async (res: Response): Promise<unknown> => {
  const text = await res.text()
  expect(text.startsWith(JSON_PREFIX)).toBe(true)
  return JSON.parse(text.slice(JSON_PREFIX.length)) as unknown
}

describe('Node adapter (real HTTP, real Set-Cookie)', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    server = await startStubServer(0)
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('runs the login flow with cookies and the XSRF header', async () => {
    // The shared MSW server fails unhandled requests; let this test's real server through on purpose.
    mswServer.use(http.all(`${base}/*`, () => passthrough()))
    const jar = new Map<string, string>()
    const send = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
      const xsrf = jar.get('XSRF-TOKEN')
      if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      for (const line of res.headers.getSetCookie()) {
        const [pair = ''] = line.split(';')
        const eq = pair.indexOf('=')
        jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      return res
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
})

describe('MSW adapter in jsdom (the component-test setup)', () => {
  const xsrfHeader = () => {
    const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie)
    return { 'X-XSRF-TOKEN': decodeURIComponent(match?.[1] ?? '') }
  }

  it('relative fetches reach the stub, and cookies land in document.cookie', async () => {
    expect(await parse(await fetch('/current-user'))).toEqual({ user: null })
    expect(document.cookie).toMatch(/XSRF-TOKEN=/)

    expect((await fetch('/login', { method: 'POST', body: JSON.stringify(CREDENTIALS.po) })).status).toBe(403)
    const login = await fetch('/login', { method: 'POST', headers: xsrfHeader(), body: JSON.stringify(CREDENTIALS.po) })
    expect(await parse(login)).toMatchObject({ user: { email: 'po@ascrum.test' } })
    expect(await parse(await fetch('/current-user'))).toMatchObject({ user: { email: 'po@ascrum.test' } })
  })

  it('resetStub() runs before each test: no session and a pristine store', async () => {
    expect(await parse(await fetch('/current-user'))).toEqual({ user: null })
    expect(await parse(await fetch(`/databases/ascrum/collections/projects/${PROJECT.webshop}`))).toMatchObject({
      name: 'Webshop',
    })
    resetStub()
    expect(document.cookie).toBe('')
  })

  it('failNext() fails exactly one matching request, with legacy-shaped bodies', async () => {
    failNext('GET', '/databases/ascrum/collections/projects', 500)
    const failed = await fetch('/databases/ascrum/collections/projects')
    expect(failed.status).toBe(500)
    expect(await parse(failed)).toHaveProperty('message')
    expect((await fetch('/databases/ascrum/collections/projects')).status).toBe(200)

    failNext('GET', '/current-user', 401)
    const unauthorized = await fetch('/current-user')
    expect(unauthorized.status).toBe(401)
    expect(await parse(unauthorized)).toEqual({ user: null })
  })
})
