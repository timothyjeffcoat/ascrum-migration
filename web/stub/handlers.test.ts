// The stub contract (AC-STUB-01..15) and the Phase 5 store-parity cases on the in-memory store.
// The same tests run on PostgreSQL in api/src/pgStore.test.ts (`pnpm test:integration`, AC-PG-01).
import { describe } from 'vitest'
import { defineContractTests, memoryBackend } from './contractTests.ts'
import { defineSecurityTests } from './securityTests.ts'

describe.each([memoryBackend])('stub contract on $name', (backend) => defineContractTests(backend))
// p5-security (Phase 5 §3.4): throttling, session rotation and expiry, no reset route. The same tests run
// on PostgreSQL in api/src/security.test.ts.
describe.each([memoryBackend])('security on $name', (backend) => defineSecurityTests(backend))
