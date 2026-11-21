// Phase 2 placeholder entry. Cluster 0 replaces the render with the spec §4.1 composition and keeps
// the in-browser stub bootstrap below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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

function Placeholder() {
  return (
    <div className="container-fluid">
      <div className="hero-unit">
        <h1>AScrum</h1>
        <p>The React conversion is in progress. The application shell arrives with cluster 0.</p>
      </div>
    </div>
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('index.html has no #root element')

await startInBrowserStub()
createRoot(rootElement).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
)
