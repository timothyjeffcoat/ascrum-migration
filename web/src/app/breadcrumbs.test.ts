// Legacy common/services/breadcrumbs.spec.js. The "not exposed before route change success" case is in
// Header.test.tsx, since it needs a pending navigation.
import { describe, expect, it } from 'vitest'
import { breadcrumbsFor } from './breadcrumbs.ts'

describe('legacy breadcrumbs cases', () => {
  it('should have sensible defaults before route navigation', () => {
    // Adapted: no path yet → no crumbs, and no first crumb.
    expect(breadcrumbsFor('')).toEqual([])
    expect(breadcrumbsFor('')[0]).toBeUndefined()
  })

  it('should correctly parse $location() after route change success', () => {
    const crumbs = breadcrumbsFor('/some/path')
    expect(crumbs).toEqual([
      { name: 'some', path: '/some' },
      { name: 'path', path: '/some/path' },
    ])
    expect(crumbs[0]).toEqual({ name: 'some', path: '/some' })
  })
})
