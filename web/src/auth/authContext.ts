import { createContext } from 'react'
import type { CurrentUser } from '../api/types.ts'

/** What components see of legacy `security` (CLAUDE.md: context only for auth). */
export type Auth = {
  currentUser: CurrentUser | null
  isAuthenticated: boolean
  isAdmin: boolean
  /** Legacy `showLogin`: opens the dialog (no-op if open, S7). */
  showLogin(): void
  login(email: string, password: string): Promise<boolean>
  /** Legacy `cancelLogin`: closes the dialog, rejects every queued item, navigates to '/'. */
  cancelLogin(): void
  /** POST `/logout`, clear the user, navigate to '/'. Failures are not surfaced (D19). */
  logout(): void
}

export const AuthContext = createContext<Auth | null>(null)
