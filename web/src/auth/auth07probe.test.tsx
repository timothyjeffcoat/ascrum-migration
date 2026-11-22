// THROWAWAY CI PROBE for DEV-foundation-06. Never merged; the draft PR is closed after one run.
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { recordRequests, renderRoute, resetClientState } from '../test/renderRoute.tsx'
import { getCurrentUser } from './currentUser.ts'

beforeEach(() => resetClientState())

for (let i = 0; i < 40; i++) {
  it(`AUTH07PROBE run ${i}`, async () => {
    const { router, user } = await renderRoute('/projects', { as: 'po' })
    await waitFor(() => expect(router.state.initialized).toBe(true))
    const btn = await screen.findByRole('button', { name: 'Log out' })
    const pageAtFind = document.querySelector('.container-fluid')?.children.length ?? -1
    const seen = recordRequests()
    await user.click(btn)
    const connectedAfterClick = btn.isConnected
    let ok = true
    try {
      await waitFor(() => expect(router.state.location.pathname).toBe('/projectsinfo'))
    } catch {
      ok = false
    }
    console.log(
      `AUTH07PROBE ${ok ? 'OK' : 'STALL'} i=${i} pageChildrenAtFind=${pageAtFind} btnConnectedAfterClick=${connectedAfterClick} ` +
        `requests=${JSON.stringify(seen.map((r) => r.method + ' ' + r.pathname))} user=${getCurrentUser() ? 'set' : 'null'} ` +
        `loc=${router.state.location.pathname} nav=${router.state.navigation.state}`,
    )
  }, 10000)
}
