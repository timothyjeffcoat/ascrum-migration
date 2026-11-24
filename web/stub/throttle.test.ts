// DEV-p5-security-13: the per-IP throttle key. The behaviour through handle() (shared limits, both
// stores) is in securityTests.ts; this pins the normalisation itself, spelling by spelling.
import { describe, expect, it } from 'vitest'
import { addressKey, DEFAULT_THROTTLE, throttleKeys } from './throttle.ts'

describe('DEV-p5-security-13: addressKey()', () => {
  it('DEV-p5-security-13: an IPv4 address is its own key', () => {
    expect(addressKey('203.0.113.5')).toBe('203.0.113.5')
    expect(addressKey(' 203.0.113.5 ')).toBe('203.0.113.5')
  })

  it('DEV-p5-security-13: an IPv6 address is keyed by its /64, whatever the spelling', () => {
    const same = [
      '2001:db8:0:1::1',
      '2001:db8:0:1:ffff:ffff:ffff:ffff',
      '2001:0DB8:0000:0001:0000:0000:0000:0002',
      '2001:db8::1:0:0:0:3', // `::` inside the /64: the third group is the zero it stands for
      '2001:db8:0:1:a:b:c:d',
      '2001:db8:0:1::192.0.2.1', // a dotted tail
      '[2001:db8:0:1::4]', // brackets, as in a URL
      '2001:db8:0:1::5%eth0', // a zone id
      '2001:db8:0:1::6%25en0',
    ]
    for (const address of same) expect(addressKey(address), address).toBe('2001:db8:0:1::/64')
    expect(addressKey('2001:db8:0:2::1')).toBe('2001:db8:0:2::/64')
    expect(addressKey('::')).toBe('0:0:0:0::/64')
    expect(addressKey('::1')).toBe('0:0:0:0::/64')
    expect(addressKey('2001:db8::')).toBe('2001:db8:0:0::/64')
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  it('DEV-p5-security-13: an IPv4-mapped IPv6 address keys as the IPv4 address, in every spelling', () => {
    for (const address of [
      '::ffff:203.0.113.20',
      '::FFFF:203.0.113.20',
      '::ffff:cb00:7114',
      '0:0:0:0:0:ffff:203.0.113.20',
      '0000:0000:0000:0000:0000:FFFF:CB00:7114',
      '[::ffff:203.0.113.20]',
    ]) {
      expect(addressKey(address), address).toBe('203.0.113.20')
    }
    // Not mapped: another prefix in front of ffff, or ffff in another place.
    expect(addressKey('1::ffff:203.0.113.20')).toBe('1:0:0:0::/64')
    expect(addressKey('::ffff:0:203.0.113.20')).toBe('0:0:0:0::/64')
  })

  it('DEV-p5-security-13: something that is not an IP address is keyed as given (lower-cased), never merged with another', () => {
    for (const odd of [
      '2001:db8::1::2',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8::',
      'gggg::1',
      '12345::1',
      '::ffff:203.0.113.256',
      'unknown',
    ]) {
      expect(addressKey(odd), odd).toBe(odd.toLowerCase())
    }
  })

  it('DEV-p5-security-13: throttleKeys() uses it for the address key, and leaves the account key as sent', () => {
    expect(throttleKeys({ account: 'PO@x', ip: '2001:DB8:0:1::9' }, DEFAULT_THROTTLE)).toEqual([
      { key: 'ip:2001:db8:0:1::/64', max: DEFAULT_THROTTLE.maxFailuresPerIp },
      { key: 'account:PO@x', max: DEFAULT_THROTTLE.maxFailuresPerAccount },
    ])
  })
})
