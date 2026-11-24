import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Two projects (Phase 5, spec §3.1):
//   unit         `pnpm test`: the app and the in-memory stub, jsdom, no database. What the `test` CI job runs.
//   integration  `pnpm test:integration`: api/ on PostgreSQL. Needs DATABASE_URL and fails without it.
export default defineConfig({
  test: {
    allowOnly: false, // a stray .only fails the run instead of silently narrowing it
    passWithNoTests: false,
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'unit',
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
          include: ['src/**/*.test.{ts,tsx}', 'stub/**/*.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['../api/src/**/*.test.ts'],
        },
      },
    ],
  },
})
