// The stub contract (AC-STUB-01..15) and the Phase 5 store-parity cases on the in-memory store.
// The same tests run on PostgreSQL in api/src/pgStore.test.ts (`pnpm test:integration`, AC-PG-01).
import { describe } from 'vitest'
import { defineContractTests, memoryBackend } from './contractTests.ts'

describe.each([memoryBackend])('stub contract on $name', (backend) => defineContractTests(backend))
