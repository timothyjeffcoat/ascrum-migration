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
import { hashPassword, verifyPassword } from './passwords.ts'
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
})
