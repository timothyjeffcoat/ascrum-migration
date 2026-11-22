import type { User } from '../api/types.ts'

/** Legacy `Users.prototype.getFullName`: "Last First (email)" (AC-DOM-03). */
export function fullName(user: Pick<User, 'firstName' | 'lastName' | 'email'>): string {
  return `${user.lastName} ${user.firstName} (${user.email})`
}
