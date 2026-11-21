// Entry point: the in-browser stub when configured, then the spec §4.1 composition (app/bootApp.tsx).
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { bootApp } from './app/bootApp.tsx'
import './styles/stylesheet.less'

/** `pnpm dev:msw` and the Pages build run the API stub in the browser (spec §7.4). */
async function startInBrowserStub(): Promise<void> {
  if (import.meta.env.VITE_STUB !== 'msw') return
  const [{ setupWorker }, { createStubContext }, { createStubHandlers }] = await Promise.all([
    import('msw/browser'),
    import('../stub/handlers.ts'),
    import('../stub/msw.ts'),
  ])
  const context = createStubContext({ allowReset: import.meta.env.MODE !== 'pages' }) // S9
  // MSW in a real browser copies mocked Set-Cookie into document.cookie itself (proven by
  // e2e/pages/pages.spec.ts, spec §11-2), so the adapter's fallback stays off here; jsdom needs it.
  const worker = setupWorker(...createStubHandlers(context, { writeDocumentCookies: false }))
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
    quiet: true,
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('index.html has no #root element')

// The stub must answer before the first request (the start-up `/current-user`) goes out.
await startInBrowserStub()
// D6: identical URLs relative to the basename ('/' or '/ascrum-migration/'), HTML5 history.
const { app } = bootApp((routes) => createBrowserRouter(routes, { basename: import.meta.env.BASE_URL }))
createRoot(rootElement).render(app)
