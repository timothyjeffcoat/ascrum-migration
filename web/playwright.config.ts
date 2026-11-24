import { defineConfig, devices } from '@playwright/test'

const CI = Boolean(process.env.CI)
// Defaults match vite.config.ts and the stub; override all three to run several worktrees in parallel.
const STUB_PORT = process.env.STUB_PORT ?? '3001'
const PREVIEW_PORT = process.env.PREVIEW_PORT ?? '4173'
const PAGES_PORT = process.env.PAGES_PORT ?? '4174'
// E2E_BASE_URL: run against a stack that is already running (the compose stack, AC-CTR-01, `pnpm
// e2e:compose`). Then the `chromium` project uses that URL, Playwright starts only the Pages server (the
// Pages build is not part of that stack), and the container checks in e2e/containers/ run too; they
// need a running stack, so the default run leaves them out. Unset: Playwright starts every server.
const EXTERNAL = process.env.E2E_BASE_URL
// Servers are never reused: a stub left running on the stub port (e.g. from `pnpm dev`) would carry stale
// state into the run. If a port is busy, Playwright fails loudly instead (review finding R2-13).

// Spec §2: Chromium only, serial (the stub is shared and stateful), every file starts with a reset.
// `pnpm e2e` builds dist/ and dist-pages/ first; these servers only serve the builds.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      // The app as `pnpm build` makes it, served by `vite preview`, API proxied to the Node stub.
      name: 'chromium',
      // Anchored at e2e/: the checkout's own path may contain "containers/" (this cluster's worktree did).
      testIgnore: EXTERNAL ? /pages\// : /pages\/|e2e\/containers\//,
      use: { ...devices['Desktop Chrome'], baseURL: EXTERNAL ?? `http://localhost:${PREVIEW_PORT}` },
    },
    {
      // The GitHub Pages build (MSW in the browser) behind a server that behaves like Pages.
      name: 'pages',
      testMatch: /pages\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PAGES_PORT}` },
    },
  ],
  webServer: [
    ...(EXTERNAL
      ? []
      : [
          { command: 'node stub/server.ts', url: `http://localhost:${STUB_PORT}/current-user` },
          { command: 'pnpm exec vite preview', url: `http://localhost:${PREVIEW_PORT}` },
        ]),
    {
      command: 'node scripts/pages-server.ts',
      url: `http://localhost:${PAGES_PORT}/ascrum-migration/`,
    },
  ],
})
