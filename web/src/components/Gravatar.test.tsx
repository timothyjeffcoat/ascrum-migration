// Legacy test/unit/common/directives/gravatar.spec.js (5 cases) plus AC-GRAV-01 / D17.
// D17: every expected URL is https where legacy expected http.
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Gravatar, gravatarUrl } from './Gravatar.tsx'
import { md5 } from './md5.ts'

const EMAIL = 'pete@bacondarwin.com'
const HASH = '9a952bcf6fd701bb1303cd9f64cf9620' // the legacy spec's expected hash
const BASE = `https://www.gravatar.com/avatar/${HASH}`

function srcOf(element: ReactElement): string | null {
  render(element)
  return screen.getByRole('img').getAttribute('src')
}

describe('Gravatar (legacy gravatar.spec)', () => {
  it('gravatar.spec:9 / D17: creates an img tag with a valid (https) gravatar url', () => {
    expect(srcOf(<Gravatar email={EMAIL} />)).toBe(BASE)
  })

  it('gravatar.spec:13: appends an s GET parameter if size is set', () => {
    expect(srcOf(<Gravatar email={EMAIL} size={200} />)).toBe(`${BASE}?s=200`)
  })

  it('gravatar.spec:18: appends a d GET parameter if default is set', () => {
    expect(srcOf(<Gravatar email={EMAIL} defaultImage="monsterid" />)).toBe(`${BASE}?d=monsterid`)
  })

  it('gravatar.spec:23: appends an f=y GET parameter if force-default is set to true', () => {
    expect(srcOf(<Gravatar email={EMAIL} forceDefault />)).toBe(`${BASE}?f=y`)
  })

  it('gravatar.spec:28: works with combinations of options', () => {
    const src = srcOf(<Gravatar email={EMAIL} size={200} defaultImage="monsterid" forceDefault />) ?? ''
    expect(src).toContain(`${BASE}?`)
    expect(src).toContain('f=y')
    expect(src).toContain('d=monsterid')
    expect(src).toContain('s=200')
  })
})

describe('Gravatar (AC-GRAV-01)', () => {
  it('AC-GRAV-01 / D17: https URL with md5(trim(lower(email))); s, d and f=y only when set', () => {
    expect(gravatarUrl('  Pete@BaconDarwin.com ')).toBe(BASE)
    expect(gravatarUrl(EMAIL, { size: 50, defaultImage: 'monsterid' })).toBe(`${BASE}?s=50&d=monsterid`)
    expect(gravatarUrl(EMAIL, { forceDefault: false, defaultImage: '' })).toBe(BASE)
    expect(gravatarUrl(EMAIL).startsWith('https://')).toBe(true)
  })

  it('AC-GRAV-01: the classes given are put on the img (legacy replace: true)', () => {
    render(<Gravatar email={EMAIL} size={200} className="img-polaroid pull-right" />)
    expect(screen.getByRole('img')).toHaveClass('img-polaroid pull-right')
  })

  it('AC-GRAV-01: an empty e-mail has no hash, as legacy rendered an undefined {{hash}}', () => {
    expect(gravatarUrl('')).toBe('https://www.gravatar.com/avatar/')
    expect(gravatarUrl(undefined, { size: 200 })).toBe('https://www.gravatar.com/avatar/?s=200')
  })
})

describe('md5 (D17)', () => {
  it('D17: md5 matches the standard digest (the legacy self-test value and the empty string)', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592')
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5(EMAIL)).toBe(HASH)
  })

  it('D17: md5 handles inputs longer than one 64-byte block and the 56-byte padding boundary', () => {
    // Expected digests computed with Node's crypto.createHash('md5').
    expect(md5('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65')
    expect(md5('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218')
    expect(md5('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367')
    expect(md5('The quick brown fox jumps over the lazy dog. '.repeat(3))).toBe('e6f263d514adf884ef6cc864d206d462')
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6')
  })

  it('D17: md5 is module-scoped and leaks no globals (legacy leaked `txt` and `add32`)', () => {
    md5('anything')
    expect('txt' in globalThis).toBe(false)
    expect('add32' in globalThis).toBe(false)
  })
})
