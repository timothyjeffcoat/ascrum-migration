import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'

// Paths the Node stub (port 3001) answers. Proxied so the browser sees one origin and real cookies.
const STUB_PATHS = ['/databases', '/login', '/logout', '/current-user', '/__stub']
const proxy = Object.fromEntries(STUB_PATHS.map((p) => [p, 'http://localhost:3001']))

// Modes:
//   development / production  base "/", Node stub via proxy (pnpm dev, pnpm build + preview, e2e)
//   msw                       base "/", stub runs in the browser via MSW (pnpm dev:msw)
//   pages                     base "/ascrum-migration/", MSW in the browser, 404.html SPA fallback
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages'
  const inBrowserStub = pages || mode === 'msw'
  return {
    // Mode decides where the stub runs; derived here rather than from .env files (CLAUDE.md: no .env in git).
    define: { 'import.meta.env.VITE_STUB': JSON.stringify(inBrowserStub ? 'msw' : 'node') },
    base: pages ? '/ascrum-migration/' : '/',
    plugins: [react(), pages && pagesSpaFallback()],
    css: {
      preprocessorOptions: { less: { math: 'always' } }, // Bootstrap 2 LESS needs it (spec §11-1)
      // Bootstrap 2 carries IE6/7 star hacks (`*zoom: 1`). Every modern browser ignores them; the
      // LightningCSS minifier rejects them unless told to drop them.
      lightningcss: { errorRecovery: true },
    },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    build: { outDir: pages ? 'dist-pages' : 'dist' },
  }
})

// GitHub Pages serves 404.html for unknown paths; a copy of index.html makes deep links boot the SPA.
function pagesSpaFallback(): Plugin {
  return {
    name: 'pages-spa-fallback',
    apply: 'build',
    async writeBundle(options) {
      const dir = options.dir ?? 'dist-pages'
      await copyFile(join(dir, 'index.html'), join(dir, '404.html'))
    },
  }
}
