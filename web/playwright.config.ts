import { defineConfig, devices } from '@playwright/test'

const CI = Boolean(process.env.CI)
// Servers are never reused: a stub left running on :3001 (e.g. from `pnpm dev`) would carry stale
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
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
    {
      // The GitHub Pages build (MSW in the browser) behind a server that behaves like Pages.
      name: 'pages',
      testMatch: /pages\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4174' },
    },
  ],
  webServer: [
    { command: 'node stub/server.ts', url: 'http://localhost:3001/current-user' },
    { command: 'pnpm exec vite preview', url: 'http://localhost:4173' },
    {
      command: 'node scripts/pages-server.ts',
      url: 'http://localhost:4174/ascrum-migration/',
    },
  ],
})
