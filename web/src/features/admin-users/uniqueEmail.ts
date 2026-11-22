// Port of admin/users/uniqueEmail.js as a useCrudForm AsyncValidator (spec §5.2, AC-USR-05).
// D9 fixed: legacy flagged any match, including the user being edited (a "TODO" in its source), so
// re-saving a user with an unchanged e-mail was impossible once the field was touched. Here a match is
// a conflict only if it is some OTHER user. Stale responses are discarded by useCrudForm (S2).
import { users } from '../../api/collections.ts'
import type { AsyncValidator } from '../../crud/useCrudForm.ts'

export const uniqueEmail: AsyncValidator<unknown> = async (value, _values, ctx) => {
  // Legacy returned without querying for an empty value.
  if (typeof value !== 'string' || value === '') return null
  const matches = await users.query({ email: value })
  return matches.some((user) => user.id !== ctx.originalId) ? 'uniqueEmail' : null
}
