import { createMemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { rotateNotificationsOn } from './rotation.ts'
import { getCurrent, pushForCurrentRoute, pushForNextRoute, remove, removeAll, rotate, subscribe } from './store.ts'

beforeEach(() => removeAll())

// Legacy common/services/notifications.spec.js. S15 dropped the sticky bucket, so the cases that used
// pushSticky use the current/next-route buckets instead (spec §9 pre-assigned "adapted").
describe('legacy notifications cases', () => {
  it('should allow to add, get and remove notifications', () => {
    const not1 = pushForCurrentRoute('watch.out', 'warning')
    const not2 = pushForCurrentRoute('just.info', 'info')
    expect(getCurrent()).toHaveLength(2)

    remove(not2)
    expect(getCurrent()).toHaveLength(1)
    expect(getCurrent()[0]).toBe(not1)

    removeAll()
    expect(getCurrent()).toHaveLength(0)
  })

  it('removal of a non-existing notification doesnt trigger errors', () => {
    expect(() => remove({ id: -1, type: 'info', message: 'not there' })).not.toThrow()
  })

  it('should remove notification after route change', () => {
    pushForCurrentRoute('goes.away', 'info')
    expect(getCurrent()).toHaveLength(1)
    rotate()
    expect(getCurrent()).toHaveLength(0)
  })

  it('should advertise a notification after a route change and remove on the subsequent route change', () => {
    pushForNextRoute('later', 'info')
    expect(getCurrent()).toHaveLength(0)
    rotate()
    expect(getCurrent()).toHaveLength(1)
    rotate()
    expect(getCurrent()).toHaveLength(0)
  })
})

// Legacy common/services/i18nNotifications.spec.js: the i18n layer is folded into the store.
describe('legacy i18nNotifications cases', () => {
  it('should add a new sticky notification based on a localized message and its type', () => {
    pushForCurrentRoute('i18n.key', 'success')
    const current = getCurrent()
    expect(current).toHaveLength(1)
    expect(current[0]?.message).toBe('?i18n.key?')
    expect(current[0]?.type).toBe('success')
  })

  it('should proxy getCurent method', () => {
    const pushed = pushForCurrentRoute('errors.route.changeError', 'error')
    expect(getCurrent()).toEqual([pushed])
  })

  it('should proxy remove method', () => {
    const pushed = pushForCurrentRoute('errors.route.changeError', 'error')
    remove(pushed)
    expect(getCurrent()).toEqual([])
  })
})

describe('notifications store', () => {
  it('AC-NOT-01: on each completed navigation (new location.key) current := next and next := []', async () => {
    const router = createMemoryRouter(
      [
        { path: '/a', Component: () => null },
        {
          path: '/b',
          loader: () => new Promise((resolve) => setTimeout(() => resolve(null), 10)),
          Component: () => null,
        },
      ],
      { initialEntries: ['/a'] },
    )
    rotateNotificationsOn(router)
    pushForCurrentRoute('stays.until.navigation', 'info')
    pushForNextRoute('shown.after.navigation', 'success')

    const navigating = router.navigate('/b')
    expect(router.state.navigation.state).toBe('loading')
    expect(getCurrent().map((n) => n.message)).toEqual(['?stays.until.navigation?']) // not yet: still loading
    await navigating
    expect(getCurrent().map((n) => n.message)).toEqual(['?shown.after.navigation?'])

    await router.revalidate() // same location key: no rotation
    expect(getCurrent()).toHaveLength(1)

    await router.navigate('/a')
    expect(getCurrent()).toEqual([])
    router.dispose()
  })

  it('AC-NOT-02: pushes take a key + params with {{name}} interpolation; a missing key renders ?key?', () => {
    pushForCurrentRoute('crud.project.remove.error', 'error', { id: 'p9' })
    pushForCurrentRoute('no.such.key', 'error', { id: 'p9' })
    expect(getCurrent().map((n) => n.message)).toEqual([
      "Something went wrong when removing project with id 'p9'.",
      '?no.such.key?',
    ])
  })

  it('snapshots are stable between changes and listeners hear every change (useSyncExternalStore contract)', () => {
    let calls = 0
    const unsubscribe = subscribe(() => (calls += 1))
    const before = getCurrent()
    expect(getCurrent()).toBe(before)
    pushForCurrentRoute('x', 'info')
    expect(getCurrent()).not.toBe(before)
    unsubscribe()
    pushForCurrentRoute('y', 'info')
    expect(calls).toBe(1)
  })
})
