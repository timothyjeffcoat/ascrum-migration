# Questions raised by cluster 1 (admin-users)

Ids are `Q-admin-users-<n>` (spec §8.5).

**Q-admin-users-1. On edit, a password-only change cannot be saved, because the password fields are `extra`.**
Context: AC-USR-04 and §5.6 make Password and Password (repeat) `extra` fields. §4.2 / AC-CRUD-01 say
`extra` is excluded from dirty, and AC-CRUD-02 says `canSave` needs dirty. So on `/admin/users/:id`,
typing a new password (both fields, matching) leaves Save disabled unless another field also changes.
In legacy the password was a model field (`user.password`), so a password-only change made the form
dirty and could be saved. A3 ("on edit, a blank password means unchanged") implies a non-blank
password on edit is a supported change. The rules contradict each other here, so the spec does not
say which wins.
Options:
- (a) Keep the spec as written: a password-only change needs some other change to be saveable.
  A regression from legacy, and nothing on screen explains it.
- (b) Make `password` a `values` field (the `User` type already has `password?`, outbound only),
  stored as `undefined` while blank so it is not dirty against the loaded user; keep
  `passwordRepeat` in `extra`. Inside cluster 1's paths; needs a §5.6 / AC-USR-04 amendment.
- (c) Cluster 0 adds a `useCrudForm` option that counts named `extra` fields towards dirty (a §4.2
  contract change; cluster 0's paths).

*Recommended: (b).* It restores legacy behaviour with the smallest change, and it stays inside the
cluster. **Implemented for now: (a), the spec as written**, because (b) and (c) both change the
contract. The worklog marks "password-only change on edit" as blocked on this question. No current
test pins the (a) behaviour as desired: the AC-USR-06 test that sends a new password also changes the
last name.

**Q-admin-users-2. Gravatar after the e-mail is cleared: keep legacy's stale image?**
Context: legacy `gravatar.js` recomputed the hash only `if (email)`, so clearing the E-mail field
on the user form kept showing the previous address's image. The spec (AC-GRAV-01) only defines the
URL for an e-mail. `components/Gravatar.tsx` is stateless: an empty e-mail gives no hash, so the URL
ends in `/avatar/` (the image legacy showed before any address was entered).
Options: (a) stateless, as implemented; (b) remember the last non-empty hash, as legacy did.
*Recommended and implemented: (a).* It is cosmetic, and copying (b) would mean component state for no
user-visible benefit. This does not block anything; it is cheap to reverse.
