import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { failNext } from '../../test/stubControl.ts'
import { recordRequests, renderRoute, type Persona } from '../../test/renderRoute.tsx'

const PROJECTS_PATH = '/databases/ascrum/collections/projects'

/** The content area the route renders into (AppShell's `.container-fluid`, legacy index.html's ng-view parent). */
function content(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Projects info' })
  if (!heading.parentElement) throw new Error('no content area')
  return heading.parentElement
}

describe('/projectsinfo (ProjectsInfo)', () => {
  for (const as of ['anonymous', 'outsider', 'admin'] satisfies Persona[]) {
    it(`AC-PIN-01 / D1: public; as ${as}, the loader fetches all projects (q={}) and the page renders only "Projects info"`, async () => {
      const requests = recordRequests()
      const { router } = await renderRoute('/projectsinfo', { as })
      expect(await screen.findByRole('heading', { name: 'Projects info' })).toBeVisible()
      expect(router.state.location.pathname).toBe('/projectsinfo')
      expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()

      const fetched = requests.filter((r) => r.pathname === PROJECTS_PATH)
      expect(fetched).toHaveLength(1)
      expect(fetched[0]?.method).toBe('GET')
      expect(fetched[0]?.q).toEqual({})
      // D1 preserved: none of the loaded projects is shown.
      expect(screen.queryByText('Webshop')).toBeNull()
      expect(screen.queryByText('Mobile App')).toBeNull()
      expect(screen.queryByRole('table')).toBeNull()
    })
  }

  it('class parity: the legacy template is a bare <h3> (no classes) and nothing else', async () => {
    await renderRoute('/projectsinfo')
    const heading = await screen.findByRole('heading', { name: 'Projects info', level: 3 })
    expect(heading.tagName).toBe('H3')
    expect(heading).not.toHaveAttribute('class')
    expect(content()).toHaveClass('container-fluid')
    expect(content().children).toHaveLength(1)
  })

  it('AC-PIN-01: a failed projects load shows "Route change error" and an empty content area', async () => {
    failNext('GET', PROJECTS_PATH, 500)
    const { router } = await renderRoute('/projectsinfo')
    expect(await screen.findByText('Route change error')).toBeVisible()
    await waitFor(() => expect(router.state.initialized).toBe(true))
    expect(screen.queryByRole('heading', { name: 'Projects info' })).toBeNull()
    // The shell's last .container-fluid is the content area (the one before it holds the notification).
    const areas = document.querySelectorAll('body > div > .container-fluid')
    expect(areas[areas.length - 1]?.children).toHaveLength(0)
  })
})
