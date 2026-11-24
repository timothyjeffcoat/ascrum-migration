// Turns web/securityHeaders.ts (owned by p5-security, spec §3.4 S-p5-5) into nginx config, at image
// build time, so the web image serves exactly that map and cannot drift from it:
//
//   node docker/web/security-headers.ts web/securityHeaders.ts > security-headers.conf
//
// For every header: `add_header <name> "<value>" always;` (also on error responses), and
// `proxy_hide_header <name>;`, so a copy the API sends is dropped and the header is never doubled on
// the routes nginx proxies. The module is required: if it is missing, or does not export
// `securityHeaders` as a non-empty map of strings, this exits non-zero and the image build fails.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// An HTTP header name (RFC 9110 token, restricted to what browsers and nginx agree on).
const NAME = /^[A-Za-z0-9-]+$/
// Inside an nginx double-quoted string, `$` starts a variable and `"` or `\` would need escaping that
// nginx handles inconsistently. No sane header value needs them, so refuse instead of escaping.
const UNSAFE_VALUE = /[$"\\\p{Cc}]/u

export function nginxConfig(headers: unknown): string {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('securityHeaders must be an object mapping header names to values')
  }
  const entries = Object.entries(headers)
  if (entries.length === 0) throw new Error('securityHeaders is empty; the web image would send no security headers')
  const lines = ['# Generated at image build time from web/securityHeaders.ts by docker/web/security-headers.ts.']
  const seen = new Set<string>()
  for (const [name, value] of entries) {
    if (!NAME.test(name)) throw new Error(`not a header name: ${JSON.stringify(name)}`)
    if (seen.has(name.toLowerCase())) throw new Error(`header given twice (names are case-insensitive): ${name}`)
    seen.add(name.toLowerCase())
    if (typeof value !== 'string' || value.trim() === '')
      throw new Error(`${name}: the value must be a non-empty string`)
    if (UNSAFE_VALUE.test(value)) throw new Error(`${name}: the value contains $, ", \\ or a control character`)
    lines.push(`proxy_hide_header ${name};`, `add_header ${name} "${value}" always;`)
  }
  return lines.join('\n') + '\n'
}

if (import.meta.main) {
  const arg = process.argv[2]
  if (!arg) throw new Error('usage: node docker/web/security-headers.ts <path to web/securityHeaders.ts>')
  const file = resolve(arg)
  if (!existsSync(file)) {
    console.error(
      `web/securityHeaders.ts is missing (looked for ${file}). The web image serves exactly the map that web/securityHeaders.ts exports ` +
        '(`export const securityHeaders: Record<string, string>`, cluster p5-security), so it cannot be built ' +
        'without it.',
    )
    process.exit(1)
  }
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  process.stdout.write(nginxConfig(mod.securityHeaders))
}
