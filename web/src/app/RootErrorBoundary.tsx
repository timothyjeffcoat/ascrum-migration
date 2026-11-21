// A2: the one addition to the legacy app. Catches errors outside the router (AuthProvider, LoginModal,
// RouterProvider itself), which RouteError can't see, and shows the `error.fatal` message in place of
// the app. The only class component in the app (CLAUDE.md): React has no hook for error boundaries.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getMessage } from '../notifications/messages.ts'
import { pushForCurrentRoute } from '../notifications/store.ts'
import { errorMessage } from './errorMessage.ts'

type RootErrorBoundaryProps = { children: ReactNode }
type RootErrorBoundaryState = { failed: false } | { failed: true; message: string }

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { failed: true, message: errorMessage(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Spec §4.1: the boundary pushes error.fatal too, so the store agrees with what is on screen.
    pushForCurrentRoute('error.fatal', 'error', { message: errorMessage(error) })
    console.error('Uncaught error outside the router', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="container-fluid">
        <div className="alert alert-error">{getMessage('error.fatal', { message: this.state.message })}</div>
      </div>
    )
  }
}
