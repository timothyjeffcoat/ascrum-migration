// Vitest setup (spec §13 item 5): jest-dom matchers, the shared MSW stub, a fresh stub per test.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { server } from './server.ts'
import { resetStub } from './stubControl.ts'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => resetStub())
afterEach(() => {
  cleanup()
  server.resetHandlers() // drops per-test overrides, including unused failNext()
})
afterAll(() => server.close())
