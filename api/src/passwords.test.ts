// AC-SEC-01 / S-p5-1: password verification, below the API (DEV-p5-security-10 and -12).
//
// Two properties a black-box test cannot see are pinned structurally here, and only that:
//   - the derived key is compared with node:crypto's timingSafeEqual, and its answer is the result
//     (DEV-p5-security-12, R1). This shows the constant-time primitive decides; it does not measure time.
//   - an unknown e-mail costs one password verification, like a known one with a wrong password
//     (DEV-p5-security-12, R20: the decoy). Again a count, not a timing measurement.
// Both spies run the real functions (mockImplementation(real)), so the code under test runs unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CREDENTIALS } from '../../web/stub/seed.ts'
import { hashPassword, PRODUCTION_SCRYPT, verifyPassword } from './passwords.ts'
import { PgStore } from './pgStore.ts'
import { pgContext, TEST_SCRYPT } from './testDb.ts'

const spies = vi.hoisted(() => ({
  timingSafeEqual: vi.fn<typeof import('node:crypto').timingSafeEqual>(),
  verifyPassword: vi.fn<typeof import('./passwords.ts').verifyPassword>(),
}))

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  spies.timingSafeEqual.mockImplementation(real.timingSafeEqual)
  return { ...real, timingSafeEqual: spies.timingSafeEqual }
})

vi.mock('./passwords.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./passwords.ts')>()
  spies.verifyPassword.mockImplementation(real.verifyPassword)
  return { ...real, verifyPassword: spies.verifyPassword }
})

afterEach(() => {
  spies.timingSafeEqual.mockClear()
  spies.verifyPassword.mockClear()
})

describe('AC-SEC-01 / DEV-p5-security-10: a malformed stored hash never matches (fails closed)', () => {
  it('AC-SEC-01 / DEV-p5-security-10: malformed, truncated, wrong-length and out-of-range values reject every password, the "right" one included', async () => {
    const good = await hashPassword('demo', TEST_SCRYPT)
    expect(await verifyPassword('demo', good)).toBe(true) // the control: the format below is right
    expect(await verifyPassword('wrong', good)).toBe(false)

    const [, log2N = '', r = '', p = '', salt = '', key = ''] = good.split('$')
    const malformed: Record<string, string> = {
      empty: '',
      'plain text (a pre-002 row)': 'demo',
      'prefix only': 'scrypt$',
      'no key': ['scrypt', log2N, r, p, salt].join('$'),
      'key truncated by one character': good.slice(0, -1),
      'key one character longer': `${good}A`,
      'salt truncated': ['scrypt', log2N, r, p, salt.slice(0, -1), key].join('$'),
      'another algorithm': ['bcrypt', log2N, r, p, salt, key].join('$'),
      'upper-case name': ['SCRYPT', log2N, r, p, salt, key].join('$'),
      'trailing newline': `${good}\n`,
      'leading space': ` ${good}`,
      'an extra field': `${good}$x`,
      'not base64url': ['scrypt', log2N, r, p, salt, `${key.slice(0, -1)}+`].join('$'),
      'log2N 0': ['scrypt', '0', r, p, salt, key].join('$'),
      'log2N 21 (over the cap)': ['scrypt', '21', r, p, salt, key].join('$'),
      'r 0': ['scrypt', log2N, '0', p, salt, key].join('$'),
      'p 0': ['scrypt', log2N, r, '0', salt, key].join('$'),
      'negative r': ['scrypt', log2N, '-8', p, salt, key].join('$'),
    }
    for (const [what, stored] of Object.entries(malformed)) {
      expect(await verifyPassword('demo', stored), what).toBe(false)
      expect(await verifyPassword('', stored), `${what}, empty password`).toBe(false)
    }
  })
})

describe('AC-SEC-01 / DEV-p5-security-15: scrypt r and p are capped, like log2N', () => {
  it('AC-SEC-01 / DEV-p5-security-15: a hash made with r over 32 or p over 16 rejects even its own password; r 32 and p 16 still verify', async () => {
    // Real hashes at those parameters (a small log2N keeps them cheap), so without the cap each would verify:
    // the rejection can only come from the cap, not from a key that does not match.
    const cases: [string, { log2N: number; r: number; p: number }, boolean][] = [
      ['r 32, p 1 (at the cap)', { log2N: 10, r: 32, p: 1 }, true],
      ['r 8, p 16 (at the cap)', { log2N: 10, r: 8, p: 16 }, true],
      ['r 33 (over the cap)', { log2N: 10, r: 33, p: 1 }, false],
      ['p 17 (over the cap)', { log2N: 10, r: 8, p: 17 }, false],
      ['log2N 1, p 16 (in range: the memory limit covers p)', { log2N: 1, r: 8, p: 16 }, true],
      ['r 99 and p 99 (the old limit)', { log2N: 4, r: 99, p: 99 }, false],
    ]
    for (const [what, params, verifies] of cases) {
      const stored = await hashPassword('demo', params)
      expect(stored.split('$').slice(1, 4), what).toEqual([params.log2N, params.r, params.p].map(String))
      expect(await verifyPassword('demo', stored), what).toBe(verifies)
      expect(await verifyPassword('wrong', stored), `${what}, wrong password`).toBe(false)
    }
  })
})

describe('AC-SEC-01 / DEV-p5-security-12: the comparison is timingSafeEqual (structural, R1)', () => {
  it('AC-SEC-01 / DEV-p5-security-12: each verification compares the two 32-byte keys with timingSafeEqual, and its answer decides', async () => {
    const stored = await hashPassword('demo', TEST_SCRYPT)
    spies.timingSafeEqual.mockClear()

    expect(await verifyPassword('demo', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
    expect(spies.timingSafeEqual).toHaveBeenCalledTimes(2)
    for (const [a, b] of spies.timingSafeEqual.mock.calls) {
      expect([a.byteLength, b.byteLength]).toEqual([32, 32])
    }
    // Its answer is the result: overturned both ways, the verification follows it.
    spies.timingSafeEqual.mockReturnValueOnce(false)
    expect(await verifyPassword('demo', stored)).toBe(false)
    spies.timingSafeEqual.mockReturnValueOnce(true)
    expect(await verifyPassword('wrong', stored)).toBe(true)
  })
})

describe('AC-SEC-01 / DEV-p5-security-12: an unknown e-mail costs a verification too (the decoy, R20)', () => {
  it('AC-SEC-01 / DEV-p5-security-12: PgStore.findLogin runs exactly one verification for an unknown e-mail, as for a known one with a wrong password', async () => {
    const { store } = await pgContext({ allowReset: true })
    const verifications = async (email: string, password: string) => {
      spies.verifyPassword.mockClear()
      expect(await store.findLogin(email, password)).toBeUndefined()
      return spies.verifyPassword.mock.calls.length
    }
    expect(await verifications(CREDENTIALS.po.email, 'not-the-password')).toBe(1)
    expect(await verifications('nobody@nowhere.test', 'not-the-password')).toBe(1)
    expect(await verifications('nobody@nowhere.test', CREDENTIALS.po.password)).toBe(1) // and again (cached decoy)
  })

  it('AC-SEC-01 / DEV-p5-security-17: the decoy costs what a real check costs: it is hashed with the store’s own scrypt parameters', async () => {
    // The count above cannot see a cheaper decoy (one hashed at log2N 10 instead of the store's cost
    // passed it). So the decoy's parameters are pinned to the store's, for two stores whose costs no
    // constant in the code matches: the cheap test cost, and one that differs from both it and
    // PRODUCTION_SCRYPT in every value.
    const { store: testStore } = await pgContext({ allowReset: true })
    const odd = { log2N: 11, r: 4, p: 2 }
    expect([odd.log2N, odd.r, odd.p]).not.toContain(TEST_SCRYPT.log2N)
    expect([
      odd.log2N !== PRODUCTION_SCRYPT.log2N,
      odd.r !== PRODUCTION_SCRYPT.r,
      odd.p !== PRODUCTION_SCRYPT.p,
    ]).toEqual([true, true, true])
    const oddStore = new PgStore(testStore.pool, { scrypt: odd })
    for (const store of [testStore, oddStore]) {
      spies.verifyPassword.mockClear()
      expect(await store.findLogin('nobody@nowhere.test', 'not-the-password')).toBeUndefined()
      expect(spies.verifyPassword).toHaveBeenCalledTimes(1)
      const decoy = String(spies.verifyPassword.mock.calls[0]?.[1])
      const { log2N, r, p } = store.scrypt
      expect(decoy.split('$').slice(0, 4), `decoy of a store at ${JSON.stringify(store.scrypt)}`).toEqual([
        'scrypt',
        String(log2N),
        String(r),
        String(p),
      ])
    }
  })
})
