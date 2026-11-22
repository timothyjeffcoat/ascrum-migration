import { defineConfig, devices } from '@playwright/test'

const CI = Boolean(process.env.CI)
// Defaults match vite.config.ts and the stub; override all three to run several worktrees in parallel.
const STUB_PORT = process.env.STUB_PORT ?? '3001'
const PREVIEW_PORT = process.env.PREVIEW_PORT ?? '4173'
const PAGES_PORT = process.env.PAGES_PORT ?? '4174'
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
      testIgnore: /pages\//,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      // The GitHub Pages build (MSW in the browser) behind a server that behaves like Pages.
      name: 'pages',
      testMatch: /pages\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PAGES_PORT}` },
    },
  ],
  webServer: [
    { command: 'node stub/server.ts', url: `http://localhost:${STUB_PORT}/current-user` },
    { command: 'pnpm exec vite preview', url: `http://localhost:${PREVIEW_PORT}` },
    {
      command: 'node scripts/pages-server.ts',
      url: `http://localhost:${PAGES_PORT}/ascrum-migration/`,
    },
  ],
})
