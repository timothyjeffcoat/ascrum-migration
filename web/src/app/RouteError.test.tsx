import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/errors.ts'
import { RetryCancelledError } from '../auth/retryQueue.ts'
import { getCurrent } from '../notifications/store.ts'
import { renderRoute } from '../test/renderRoute.tsx'
import { failNext } from '../test/stubControl.ts'
import { RootErrorBoundary } from './RootErrorBoundary.tsx'

function contentArea(): Element {
  // The third top-level block of the shell: header, notifications, then the view.
  const areas = document.querySelectorAll('body > div > .container-fluid')
  const content = areas[areas.length - 1]
  if (!content) throw new Error('no content area')
  return content
}

function Bomb(): never {
  throw new Error('kaboom')
}

/** React and the router log caught render errors; keep the output readable and prove they were logged. */
function quietConsoleErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

describe('RouteError', () => {
  it('AC-NOT-04 / S5: an ApiError in a loader → notify-current "Route change error"; the shell stays and the content is empty', async () => {
    const routes = [
      { path: '/broken', loader: () => Promise.reject(new ApiError(500)), Component: () => <p>broken page</p> },
    ]
    await renderRoute('/broken', { routes })

    const alert = await screen.findByText('Route change error')
    expect(alert).toHaveClass('alert alert-error')
    expect(screen.getByText('AScrum')).toHaveClass('brand')
    expect(screen.queryByText('broken page')).toBeNull()
    expect(contentArea()).toBeEmptyDOMElement()
    expect(getCurrent()).toHaveLength(1) // once, although StrictMode runs effects twice
  })

  it('AC-NOT-04 / D10: a failed request in a guard (HTTP 500 on /current-user) is a route change error', async () => {
    failNext('GET', '/current-user', 500) // the start-up request, which the initial guard shares (S11)
    await renderRoute('/projects')
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
  })

  it('AC-NOT-04: a guard rejection (login cancelled) is a route change error', async () => {
    const routes = [{ path: '/guarded', loader: () => Promise.reject(new RetryCancelledError()), Component: Bomb }]
    await renderRoute('/guarded', { routes })
    expect(await screen.findByText('Route change error')).toHaveClass('alert alert-error')
  })

  it('AC-NOT-05: a render error under the layout route → notify-current error.fatal {message}, with the shell intact', async () => {
    const logged = quietConsoleErrors()
    await renderRoute('/explodes', { routes: [{ path: '/explodes', Component: Bomb }] })

    expect(await screen.findByText('An unexpected error occurred: kaboom')).toHaveClass('alert alert-error')
    expect(screen.getByText('AScrum')).toHaveClass('brand')
    expect(contentArea()).toBeEmptyDOMElement()
    expect(logged).toHaveBeenCalled()
  })

  it('AC-NOT-05: a non-API loader error → error.fatal {message}', async () => {
    const routes = [
      {
        path: '/buggy',
        loader: () => {
          throw new TypeError('loader bug')
        },
        Component: () => <p>never</p>,
      },
    ]
    await renderRoute('/buggy', { routes })
    expect(await screen.findByText('An unexpected error occurred: loader bug')).toHaveClass('alert alert-error')
  })

  it('AC-NOT-05: errors outside the router → RootErrorBoundary renders the same error.fatal message', async () => {
    const logged = quietConsoleErrors()
    render(
      <RootErrorBoundary>
        <Bomb />
      </RootErrorBoundary>,
    )
    const alert = screen.getByText('An unexpected error occurred: kaboom')
    expect(alert).toHaveClass('alert alert-error')
    expect(alert.parentElement).toHaveClass('container-fluid')
    await waitFor(() => expect(getCurrent().map((n) => n.message)).toContain('An unexpected error occurred: kaboom'))
    expect(logged).toHaveBeenCalled()
  })
})
