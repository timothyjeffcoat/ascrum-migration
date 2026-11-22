// Vitest setup (spec §13 item 5): jest-dom matchers, the shared MSW stub, a fresh stub per test.
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { server } from './server.ts'
import { resetStub } from './stubControl.ts'

// waitFor/findBy give up after 1 s by default. Real feature screens (wave A) plus three PRs' CI jobs at
// once pushed honest waits past that (AC-AUTH-07 took 1.2 s on a busy runner). 3 s still fails a broken
// test well inside Vitest's 5 s test timeout. Harness decision, see spec/journal.md (2026-11-22).
configure({ asyncUtilTimeout: 3000 })

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => resetStub())
afterEach(() => {
  cleanup()
  server.resetHandlers() // drops per-test overrides, including unused failNext()
})
afterAll(() => server.close())
