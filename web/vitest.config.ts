import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
    include: ['src/**/*.test.{ts,tsx}', 'stub/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    allowOnly: false, // a stray .only fails the run instead of silently narrowing it
    passWithNoTests: false,
  },
})
