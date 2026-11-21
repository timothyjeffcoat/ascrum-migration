// Node adapter (spec §7.4): real HTTP and real cookies on port 3001, for `pnpm dev` (via the Vite
// proxy) and Playwright. Run directly with Node 24: `node stub/server.ts`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createStubContext, handle, parseBody, parseCookies, type StubContext, type StubCookie } from './handlers.ts'

export function startStubServer(
  port: number,
  ctx: StubContext = createStubContext({ allowReset: true }),
): Promise<Server> {
  const server = createServer((req, res) => {
    respond(req, res, ctx).catch((error: unknown) => {
      console.error('[stub] unexpected error', error)
      res.writeHead(500).end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

async function respond(req: IncomingMessage, res: ServerResponse, ctx: StubContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://stub.local')
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)

  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }

  const out = handle(
    {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      cookies: parseCookies(req.headers.cookie),
      body: parseBody(Buffer.concat(chunks).toString('utf8')),
    },
    ctx,
  )

  if (out.setCookies.length > 0) res.setHeader('Set-Cookie', out.setCookies.map(formatCookie))
  res.writeHead(out.status, out.headers)
  res.end(out.body ?? undefined)
}

function formatCookie(cookie: StubCookie): string {
  return `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=/${cookie.httpOnly ? '; HttpOnly' : ''}`
}

if (import.meta.main) {
  const port = Number(process.env.STUB_PORT ?? 3001)
  await startStubServer(port)
  console.log(`[stub] listening on http://localhost:${port}`)
}
