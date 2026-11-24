import { defineConfig } from 'vitest/config'

// Unit tests of the stacks (CDK assertions) and of the workflow scripts. Nothing here talks to AWS or
// GitHub: the scripts take their `aws`/GitHub calls as a parameter, and the tests pass fakes.
export default defineConfig({
  test: {
    allowOnly: false, // a stray .only fails the run instead of silently narrowing it
    passWithNoTests: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Synthesising a stack takes a few seconds; several files do it.
    testTimeout: 60_000,
  },
})
