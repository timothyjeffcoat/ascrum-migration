// PgStore against the stub contract and the Phase 5 store ACs (spec §5.1). Needs DATABASE_URL.
import { describe, expect, it } from 'vitest'
import {
  body,
  Client,
  coll,
  defineContractTests,
  defineNodeAdapterTests,
  dumpCollections,
  ids,
  memoryBackend,
  q,
  reset,
} from '../../web/stub/contractTests.ts'
import { BACKLOG, PROJECT, SPRINT, USER } from '../../web/stub/seed.ts'
import { COLLECTIONS } from '../../web/stub/store.ts'
import { pgBackend, pgContext } from './testDb.ts'

describe('AC-PG-01: the stub contract (AC-STUB-01..15) and store parity, run by the same code on PgStore', () => {
  defineContractTests(pgBackend)
})

describe('AC-PG-01: the Node adapter over PgStore (real HTTP, real cookies)', () => {
  defineNodeAdapterTests(pgBackend)
})

describe('AC-PG-03: the PostgreSQL seed is the memory seed', () => {
  it('AC-PG-03: after a reset, every collection reads back the same as the memory store, byte for byte', async () => {
    const memory = await memoryBackend.createContext({ allowReset: true })
    const postgres = await pgBackend.createContext({ allowReset: true })
    // Change both, then reset both: the comparison is about what a reset produces.
    for (const ctx of [memory, postgres]) {
      const admin = await new Client(ctx).login('admin')
      await admin.call('DELETE', coll('projects', PROJECT.webshop))
      await admin.call('POST', coll('tasks'), { name: 'gone after reset' })
      await reset(ctx)
    }
    const fromMemory = await dumpCollections(memory)
    const fromPostgres = await dumpCollections(postgres)
    expect(Object.keys(fromPostgres)).toEqual([...COLLECTIONS])
    for (const c of COLLECTIONS) {
      expect(JSON.parse((fromPostgres[c] ?? '').slice(6)), c).toEqual(JSON.parse((fromMemory[c] ?? '').slice(6)))
      expect(fromPostgres[c], `${c}: raw body`).toBe(fromMemory[c])
    }
  })
})

describe('AC-PG-04 / D13: partial documents and dangling references', () => {
  it('AC-PG-04: "Legacy Cleanup" has no teamMembers, and a PUT of what was read keeps it absent', async () => {
    const ctx = await pgContext({ allowReset: true })
    const admin = await new Client(ctx).login('admin')
    const read = body(await admin.call('GET', coll('projects', PROJECT.legacyCleanup))) as Record<string, unknown>
    expect(read).toEqual({
      _id: { $oid: PROJECT.legacyCleanup },
      name: 'Legacy Cleanup',
      desc: 'Retire the old intranet',
      productOwner: USER.admin,
    })
    expect(body(await admin.call('PUT', coll('projects', PROJECT.legacyCleanup), read))).toEqual(read)
    expect(body(await admin.call('GET', coll('projects', PROJECT.legacyCleanup)))).not.toHaveProperty('teamMembers')
  })

  it('AC-PG-04: the sprint backlog id of a deleted item survives a round trip, in place', async () => {
    const ctx = await pgContext({ allowReset: true })
    const dev = await new Client(ctx).login('dev1')
    const sprint = body(await dev.call('GET', coll('sprints', SPRINT.webshop1))) as Record<string, unknown>
    expect(sprint.sprintBacklog).toEqual([BACKLOG.catalogue, BACKLOG.cart, BACKLOG.deleted])
    expect((await dev.call('GET', coll('productbacklog', BACKLOG.deleted))).status).toBe(404)

    const renamed = { ...sprint, name: 'Sprint 1 (renamed)' }
    expect(body(await dev.call('PUT', coll('sprints', SPRINT.webshop1), renamed))).toEqual(renamed)
    expect(body(await dev.call('GET', coll('sprints', SPRINT.webshop1)))).toEqual(renamed)
  })
})

describe('AC-PG-05: q is parameterised SQL only', () => {
  it('AC-PG-05: SQL in a q value or a q field name matches nothing and harms nothing', async () => {
    const ctx = await pgContext({ allowReset: true })
    const anon = await new Client(ctx).prime()
    const attacks = [
      { name: "x' OR '1'='1" },
      { name: "x' OR 1=1 --" },
      { name: "'; DROP TABLE projects; --" },
      { "name' OR '1'='1": 'x' },
      { 'name = name OR true; --': 'x' },
      { 'extra ? $1': 'x' },
    ]
    for (const attack of attacks) {
      const res = await anon.call('GET', coll('projects'), undefined, q(attack))
      expect(res.status, JSON.stringify(attack)).toBe(200)
      expect(body(res), JSON.stringify(attack)).toEqual([])
    }
    const users = await anon.call('GET', coll('users'), undefined, q({ email: "' OR ''='" }))
    expect(body(users)).toEqual([])
    // Everything is still there.
    expect(ids(await anon.call('GET', coll('projects')))).toHaveLength(3)
    expect(ids(await anon.call('GET', coll('users')))).toHaveLength(6)
  })

  it('AC-PG-05: SQL in a login or an id is just text', async () => {
    const ctx = await pgContext({ allowReset: true })
    const anon = await new Client(ctx).prime()
    const login = await anon.call('POST', '/login', { email: "admin@abc.com' --", password: "' OR '1'='1" })
    expect(body(login)).toEqual({ user: null })
    expect((await anon.call('GET', coll('projects', "1' OR '1'='1"))).status).toBe(404)
  })
})

describe('DEV-p5-store-04: values PostgreSQL cannot hold', () => {
  it('DEV-p5-store-04: a NUL character or a lone surrogate is refused with 400, and nothing is stored', async () => {
    const ctx = await pgContext({ allowReset: true })
    const dev = await new Client(ctx).login('dev1')
    for (const bad of [{ name: 'a\u0000b' }, { name: 'ok', nested: ['\ud800'] }, { ['k\u0000']: 1 }]) {
      const res = await dev.call('POST', coll('tasks'), bad)
      expect(res.status).toBe(400)
      expect(body(res)).toHaveProperty('message')
      expect((await dev.call('PUT', coll('tasks', '500000000000000000000001'), bad)).status).toBe(400)
    }
    // The counter did not move: the next id is still the first one (AC-STUB-15).
    const created = body(await dev.call('POST', coll('tasks'), { name: 'fine 👋' }))
    expect(created).toEqual({ _id: { $oid: 'f00000000000000000000001' }, name: 'fine 👋' })
    expect(ids(await dev.call('GET', coll('tasks')))).toHaveLength(13)
  })
})
