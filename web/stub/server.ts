// Node adapter (spec §7.4): real HTTP and real cookies on port 3001, for `pnpm dev` (via the Vite
// proxy) and Playwright. Run directly with Node 24: `node stub/server.ts`. The API (api/src/main.ts)
// is this same adapter over PostgreSQL, with the options below set from its configuration.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createStubContext, handle, parseBody, parseCookies, type StubContext, type StubCookie } from './handlers.ts'

export type ServerOptions = {
  /**
   * S-p5-2 / AC-SEC-02: production mode adds `Secure` to both cookies, so they only travel over HTTPS.
   * Off for the local stub and the API in development mode, which run on plain http://localhost.
   */
  secureCookies?: boolean
  /**
   * How many reverse proxies in front of this server append to X-Forwarded-For (0: none, trust the
   * socket address). See clientIpOf().
   */
  trustProxyHops?: number
}

export function startStubServer(
  port: number,
  ctx: StubContext = createStubContext({ allowReset: true }),
  options: ServerOptions = {},
): Promise<Server> {
  const server = createServer((req, res) => {
    respond(req, res, ctx, options).catch((error: unknown) => {
      console.error('[stub] unexpected error', error)
      res.writeHead(500).end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StubContext,
  options: ServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://stub.local')
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)

  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }

  const out = await handle(
    {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      cookies: parseCookies(req.headers.cookie),
      body: parseBody(Buffer.concat(chunks).toString('utf8')),
      clientIp: clientIpOf(
        { remoteAddress: req.socket.remoteAddress, forwardedFor: headers['x-forwarded-for'] },
        options.trustProxyHops ?? 0,
      ),
    },
    ctx,
  )

  if (out.setCookies.length > 0) {
    res.setHeader(
      'Set-Cookie',
      out.setCookies.map((cookie) => formatCookie(cookie, options.secureCookies ?? false)),
    )
  }
  res.writeHead(out.status, out.headers)
  res.end(out.body ?? undefined)
}

/**
 * S-p5-2: `SameSite=Lax` always (the app is one origin, so nothing legitimate sends these cookies from
 * another site's POST); `Secure` in production. `sid` is HttpOnly; XSRF-TOKEN must stay readable by
 * script, because the front end copies it into the X-XSRF-TOKEN header (legacy AngularJS scheme).
 */
function formatCookie(cookie: StubCookie, secure: boolean): string {
  const attributes = ['Path=/', ...(cookie.httpOnly ? ['HttpOnly'] : []), ...(secure ? ['Secure'] : []), 'SameSite=Lax']
  return [`${cookie.name}=${encodeURIComponent(cookie.value)}`, ...attributes].join('; ')
}

/**
 * The client address used for per-IP login throttling (S-p5-3).
 *
 * X-Forwarded-For is a list each proxy appends to: "client, proxy1, proxy2". Anything a client sends
 * itself ends up on the left, so only the entries appended by proxies we run can be believed. With
 * `trustedHops` = n, the n-th entry from the right is the address the outermost trusted proxy saw: the
 * client. With 0 (the default) the header is ignored and the socket address is used, so a client that
 * talks to the API directly cannot pick its own throttling key. Fewer entries than hops means the request
 * skipped some proxies; the left-most entry is then the best address there is.
 *
 * Deployment (wave C): CloudFront → ALB → API is 2 hops (CloudFront appends the viewer address, the ALB
 * appends CloudFront's). That only holds if the ALB accepts traffic from CloudFront alone; otherwise a
 * client could reach the ALB directly with a forged first entry.
 */
export function clientIpOf(
  source: { remoteAddress: string | undefined; forwardedFor: string | undefined },
  trustedHops: number,
): string | undefined {
  const entries = (source.forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  const address =
    trustedHops > 0 && entries.length > 0 ? entries[Math.max(0, entries.length - trustedHops)] : source.remoteAddress
  // IPv4 clients of a dual-stack socket show up as ::ffff:a.b.c.d; one client, one key.
  return address?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')
}

if (import.meta.main) {
  const port = Number(process.env.STUB_PORT ?? 3001)
  await startStubServer(port)
  console.log(`[stub] listening on http://localhost:${port}`)
}
