// Serves dist-pages/ the way GitHub Pages does, so e2e can prove spec §11-3 locally and in CI:
//   - the site lives under /ascrum-migration/
//   - an existing file is served as-is; anything else gets 404.html with status 404 (the SPA fallback)
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const BASE = '/ascrum-migration/'
const ROOT = join(import.meta.dirname, '..', 'dist-pages')
const PORT = Number(process.env.PAGES_PORT ?? 4174)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

async function fileFor(pathname: string): Promise<string | null> {
  if (!pathname.startsWith(BASE)) return null
  let relative = normalize(decodeURIComponent(pathname.slice(BASE.length)))
  if (relative.startsWith('..')) return null
  if (relative === '.' || relative.endsWith('/')) relative = join(relative, 'index.html')
  const full = join(ROOT, relative)
  try {
    return (await stat(full)).isFile() ? full : null
  } catch {
    return null
  }
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://pages.local')
  void (async () => {
    const file = await fileFor(pathname)
    if (file) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(await readFile(file))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(await readFile(join(ROOT, '404.html')))
  })().catch(() => res.writeHead(500).end())
}).listen(PORT, () => console.log(`[pages] serving dist-pages at http://localhost:${PORT}${BASE}`))
