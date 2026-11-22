# Independent legacy audit: wave A screens

Auditor: independent agent, second reading of `legacy/` (the first reading is `spec/inventory.md`).
Scope: app shell, admin users, admin projects, projects list (`/projects`), product backlog.

Method: Part 1 was written from `legacy/` alone, before opening anything under `spec/`, `web/`,
`MIGRATION.md`, `CLAUDE.md` or `README.md`, and committed on its own so the history shows the blind
reading came first. Part 2 compares it with the inventory, the spec, the deviations log and, for each
discrepancy, the shipped React code.

Paths below are relative to `legacy/client/src/` unless they start with `legacy/` or `vendor/`
(`vendor/` = `legacy/client/vendor/`) or `server/` (= `legacy/server/`).

---

## Part 1 — blind reading

Each claim has an id (L-n) so Part 2 can classify it.

### Background mechanics that shape every screen

- **L1. Versions.** AngularJS is `v1.2.0-rc.3` (`vendor/angular/angular.js:2`); dialogs come from a custom
  angular-ui bootstrap build (`vendor/angular-ui/bootstrap/ui-bootstrap-custom-0.1.0-SNAPSHOT.js`).
- **L2. Data access.** Every collection goes through `mongolabResource` at
  `/databases/ascrum/collections/<name>` (`app/app.js:15-18`, `vendor/mongolab/mongolab-resource.js:5`).
  Lists are `GET ...?q=<JSON>` (`:49-53`); get-by-id `GET .../<id>` (`:55-58`); create `POST` (`:76-79`);
  update `PUT .../<id>` with `_id` blanked from the body (`:81-84`); delete `DELETE .../<id>` (`:86-89`).
  `$saveOrUpdate` picks PUT when the item has an id, POST otherwise (`:91-97`).
- **L3. HTTP errors are swallowed into "success with undefined".** On a failed request the resource
  helper calls the error callback and then *returns `undefined`*, which resolves the promise instead of
  rejecting it (`vendor/mongolab/mongolab-resource.js:35-38`). Consequence: a failed list load in a route
  resolve does **not** fail the route; the page renders with `undefined` data (empty table, no message).
  A failed get-by-id gives the edit controller `undefined`, and `crudEdit` then throws while checking the
  resource's methods (`common/directives/crud/edit.js:20-31`), leaving a broken form.
- **L4. Not-found is the only rejection.** A single-item response whose body is the literal string
  `" null "` is turned into a rejection `{code:'resource.notfound'}` (`vendor/mongolab/mongolab-resource.js:24-28`),
  which fails the route change and triggers the "Route change error" notification (L17).
- **L5. Server access rules.** All `GET`s on collections are open to anyone, including anonymous users
  (`server/server.js:44-50`). Any non-GET requires a logged-in user (`:45-47`), and non-GETs on `users` and
  `projects` require an admin (`:53-56`). Both failures answer **401** with `{user: <current user or null>}`
  (`server/lib/security.js:26-41`). Non-GETs also need the `X-XSRF-TOKEN` header matching the
  `XSRF-TOKEN` cookie, else **403** (`server/lib/xsrf.js:15-36`); Angular sends it automatically.
  JSON responses are prefixed with `)]}',\n` (`server/lib/protectJSON.js:17`).
- **L6. Passwords are readable by anyone.** Because GETs are open (L5) and the proxy returns whole
  documents (`server/lib/mongo-proxy.js:39-58`), `GET /databases/ascrum/collections/users` returns every
  user's plaintext password; passwords are stored and compared in plaintext
  (`server/lib/mongo-strategy.js:61-70`, TODO at `:74`). The admin screens fetch this list (L21, L33).
- **L7. 401 → login modal → retry.** A response interceptor catches any 401, parks the request in a
  retry queue with reason `unauthorized-server`, and returns a promise that settles only when the queue
  is retried or cancelled (`common/security/interceptor.js:7-16`). Adding to the queue opens the login
  modal (`common/security/security.js:41-45`). Login success retries every parked item (`:30-34`);
  cancel rejects them and redirects to `/` (`:35-37`).
- **L8. Route guards.** `requireAuthenticatedUser` / `requireAdminUser` first ask `GET /current-user`
  (only if nobody is cached client-side), then, if the check fails, park a retry with reason
  `unauthenticated-client` / `unauthorized-client` (`common/security/authorization.js:21-39`). That opens the
  login modal; the route stays pending until login (retry re-runs the guard) or cancel (route fails).
  The guard runs **in parallel** with the route's data resolves, so the data GETs fire even for a user who
  will be refused (`app/admin/users/admin-users.js:13-26`).
- **L9. Edit-form behaviour (`crudEdit`, shared by every edit screen).** It snapshots the item at link
  time (`common/directives/crud/edit.js:22`). **Save** is enabled only when the form is valid *and* the item
  differs from the snapshot (`:74-76`); **Revert changes** is enabled when it differs (`:77-79`) and restores
  the snapshot and marks the form pristine (`:59-63`); **Remove** is shown only for items that already have
  an id (`:80-82`) and calls DELETE (`:64-70`). Callbacks fall back: `onRemove` → `onSave` if the screen
  defines no `onRemove` (`:50`); missing `onError` is a no-op (`:52`). There is **no confirmation** before
  Remove anywhere. Buttons are `Save` (`btn btn-primary save`), `Revert changes` (`btn btn-warning revert`),
  `Remove` (`btn btn-danger remove`), all `type="button"` (`common/directives/crud/crudButtons.js:8-12`).
- **L10. Validation messages show immediately, not on touch.** `showError` returns the raw error flag
  with no dirty/touched check (`common/directives/crud/edit.js:101-103`), and `required` validates the
  initial model value via a formatter (`vendor/angular/angular.js:15561-15580`). So a blank "new" form
  shows every "This field is required." at once.

### App shell

- **L11. Page skeleton.** Header, then a notifications area (rendered only when there is at least one
  notification), then the routed view (`index.html:12-16`). The app starts by asking
  `GET /current-user` to restore a previous session (`app/app.js:41-45`).
- **L12. `/` and unknown routes.** Every unknown client path, including `/`, redirects to `/projectsinfo`
  (`app/app.js:38`). The server returns `index.html` for any non-static path (`server/lib/routes/appFile.js:3-6`);
  unknown `/static/*` files are a bare 404 (`server/lib/routes/static.js:10-12`).
- **L13. `/projectsinfo` (the landing page) shows only the heading "Projects info".** It fetches all
  projects but the template never displays them (`app/projectsinfo/projectsinfo.js:3-15`,
  `app/projectsinfo/list.tpl.html:1`). No guard.
- **L14. Header / nav** (`app/header.tpl.html`, `app/app.js:60-83`):
  - Brand "AScrum" has no href; clicking it goes to `/dashboard` if logged in, else `/projectsinfo`
    (`header.tpl.html:3`, `app.js:68-74`). (`/dashboard` itself has no guard: `app/dashboard/dashboard.js:4-17`.)
  - "Current Projects" → `/projectsinfo`, always shown (`header.tpl.html:5`).
  - Logged in: "My Projects" → `/projects` (`:8-9`).
  - Logged in **and** admin: an "Admin" dropdown with "Manage Projects" → `/admin/projects` and
    "Manage Users" → `/admin/users` (`:10-15`). The dropdown toggles on click and closes when a menu item is
    clicked; clicking elsewhere does **not** close it (it is driven by an `isAdminOpen` flag, not by
    Bootstrap's `data-toggle`, `:10-14`).
  - Active highlighting compares the **first path segment** to `projectsinfo` / `projects` / `admin`
    (`app.js:76-78`); nothing is highlighted on `/dashboard`. Product backlog pages count as `projects`.
  - A spinner image appears at the right while any HTTP request is pending (`header.tpl.html:18-21`,
    `common/services/httpRequestTracker.js:5-7`).
- **L15. Login toolbar** (`common/security/login/toolbar.tpl.html`, `toolbar.js`): anonymous users see a
  "Log in" button (`btn login`); logged-in users see "`firstName lastName`" as a link to `#` and a
  "Log out" button (`btn logout`). It updates whenever the current user changes (`toolbar.js:15-19`).
- **L16. Breadcrumbs** (`common/services/breadcrumbs.js:9-22`, `header.tpl.html:24-34`). Rebuilt only after a
  successful route change. Each **raw path segment** becomes one crumb (e.g. `/admin/users/5` →
  `admin` / `users` / `5`; ids and `new` appear literally, lower-case, untranslated). Every crumb is
  preceded by a `/` divider (including the first). All but the last are links to the cumulative path;
  the last is plain text. Several crumb links point at non-routes (`/admin`, `/projects/<id>`) and so
  bounce to `/projectsinfo` via L12.
- **L17. Notifications** (`common/services/notifications.js`, `i18nNotifications.js`, `app/notifications.tpl.html`).
  Each shows as `alert alert-<type>` with a close button "x" that removes it. "Current route" messages
  appear immediately; "next route" messages appear after the next successful navigation; on every
  successful route change the current list is replaced by the queued next-route list
  (`notifications.js:18-23`), so messages last exactly one page. Repeated pushes stack (duplicates allowed).
  Any failed route change shows **"Route change error"** (type `error`) (`app/app.js:22`, `:55-57`).
  Unknown message keys would render as `?key?` (`common/services/localizedMessages.js:3-5`). The
  exception-handler module (which would push `error.fatal`) is **not** loaded by the app (`app/app.js:1-13`),
  and sticky notifications are never used.
- **L18. Login modal** (`common/security/login/form.tpl.html`, `LoginFormController.js`, `security.js:16-38`):
  - Opens from "Log in", from any 401 (L7) or from a guard (L8). Title "Sign in". Info alert
    "Please enter your login details". Fields "E-mail" (type email, required, autofocus) and "Password"
    (required). Buttons "Sign in" (`btn btn-primary login`, disabled while the form is invalid), "Clear"
    (`btn clear`, empties both fields) and "Cancel" (`btn btn-warning cancel`).
  - Reason banner (`alert alert-warning`) only when opened by the queue (L7/L8): if someone is already
    logged in, "You do not have the necessary access permissions.  Do you want to login as someone else?"
    (two spaces after the full stop), otherwise "You must be logged in to access this part of the
    application." (`LoginFormController.js:15-19`, `app/app.js:30-31`). Opening from the "Log in" button shows
    no banner.
  - Submit: `POST /login {email, password}` (`security.js:61-69`). Pressing Enter in a field also submits
    (the buttons have no `type`, so "Sign in" is the form's default button) unless the form is invalid.
  - Bad credentials: the server answers **200 `{user: null}`** (`server/lib/security.js:49`), the modal stays
    open and shows (`alert alert-error`) "Login failed.  Please check your credentials and try again."
    (`LoginFormController.js:28-31`, `app/app.js:32`). Fields are not cleared.
  - Server/network error: "There was a problem with authenticating: {{exception}}." where `exception`
    is the whole `$http` response object, so the user sees a JSON dump of it
    (`LoginFormController.js:32-35`, `app/app.js:33`, `vendor/angular/angular.js:7313-7317`).
  - Login also fails if two users share the email (lookup requires exactly one match,
    `server/lib/mongo-strategy.js:51-58`). See L44.
  - Success: modal closes; queued requests/guards are retried; **no navigation** otherwise (user stays on
    the current page) (`security.js:30-34`, `:63-68`). The error banner is cleared at the start of each attempt.
  - Cancel: rejects all queued items and navigates to `/` (→ `/projectsinfo`) (`security.js:35-37`, `:73-76`).
    **Esc and clicking the backdrop behave exactly like Cancel** (the dialog closes with no result,
    `vendor/angular-ui/bootstrap/ui-bootstrap-custom-0.1.0-SNAPSHOT.js:28-29`, `:81-93`; `security.js:30-37`).
  - Retry loop: a logged-in non-admin who logs in again as another non-admin from an admin guard is
    re-guarded and the modal reopens with the "not authorized" banner (`authorization.js:32-38`).
  - Opening a second dialog while one is open throws (`security.js:19-21`); it is caught and logged by the
    queue (`retryQueue.js:16-22`), so concurrent 401s produce one modal.
- **L19. Logout.** "Log out" sends `POST /logout` (server answers 204, `server/lib/security.js:57-60`); only
  after success is the user cleared and the app navigates to `/` → `/projectsinfo` (`security.js:79-84`).
  If the POST fails nothing happens (no message; the user stays logged in on screen).

### Admin users (`/admin/users`, `/admin/users/new`, `/admin/users/:itemId`)

- **L20. Guard.** All three routes require an admin (`app/admin/users/admin-users.js:13-26`). Anonymous →
  login modal with "You must be logged in…"; logged-in non-admin → modal with "You do not have the
  necessary access permissions…" (L18). Cancel → `/projectsinfo`. The users GET has already gone out (L8).
- **L21. List** (`users-list.tpl.html`). Table `table table-bordered table-condensed table-striped table-hover`
  with headers (blank), "E-mail", "Last name", "First name" — 4 header cells but 5 body cells (the Remove
  column has no header) (`:3-16`). Each row: gravatar (50px, default image `monsterid`), email, last name,
  first name, "Remove" (`btn btn-danger remove`). No empty-state row. Below: well with "New User" (`btn`)
  → `/admin/users/new` (`:20-22`, `common/services/crud.js:72-74`).
- **L22. Row click** → `/admin/users/<id>` (`users-list.tpl.html:11`, `crud.js:76-78`).
- **L23. Remove from list.** No confirmation. The click does not open the row (`admin-users-list.js:14`).
  `DELETE`; on success the row disappears and a success notification "A user with id '<id>' was removed
  successfully." shows on the same page; on failure an error "Something went wrong when removing user with
  id '<id>'." (`admin-users-list.js:17-23`, `app/app.js:24-25`).
- **L24. Edit form layout** (`users-edit.tpl.html`). `div.well > form[novalidate]`, legend "User", a 200px
  gravatar floated right (`img-polaroid pull-right`), then fields in order: "E-mail" (type email, required,
  unique), "Last name" (required), "First name" (required), "Password" (required), "Password (repeat)"
  (required, must equal Password), "Admin" checkbox, then the crud buttons (L9). Inputs are `span6`.
- **L25. Validation messages (verbatim), each `span.help-inline`:** email: "This field is required.",
  "Please enter a valid email address.", "This email address is not available - please enter another.";
  last/first name/password/repeat: "This field is required."; mismatch: "Passwords do not match." —
  shown **twice**, once under Password and once under Password (repeat) (`users-edit.tpl.html:7-23`).
  Per L10 a new form shows all five "This field is required." immediately.
- **L26. Password behaviour on edit.** The Password field is pre-filled with the user's stored password
  and the repeat field with the same value (`admin-users-edit.js:10-11`), so an unchanged edit is valid
  and keeps the password. Changing Password makes the repeat invalid until it matches
  (`validateEquals.js:22-24`). "Revert changes" restores Password but **not** the repeat field, so after a
  revert the mismatch message can appear (repeat lives outside the item, `edit.js:59-63`).
- **L27. Email uniqueness** (`uniqueEmail.js`). Checked only when the user types in the field (not on
  load), by `GET users?q={"email":"<value>"}`; any match → invalid (`:16-27`). Exact, case-sensitive match
  (Mongo query). Not excluded: the user's own record — if an admin edits the email and then types the
  original back, it is reported as "not available" (TODO at `:13`). The check is asynchronous and skipped
  for empty/invalid input, so the flag can be stale (e.g. type a taken email, then clear → the
  not-available flag remains alongside "required"). No server-side uniqueness exists (L5, L53).
- **L28. Gravatar** (`common/directives/gravatar.js`). `<img src="http://www.gravatar.com/avatar/<md5 of
  trimmed lower-cased email>?s=<size>[&d=<default>]">` (`:8`, `:18-46`). Parameter order is `s`, then `d`.
  With no email yet the hash is empty (`/avatar/?s=200`). The hash only updates for a truthy email, so
  clearing the field or typing an invalid address leaves the previous picture (`:18-22`). Plain `http`.
- **L29. Admin checkbox** binds `user.admin`; ticking then unticking leaves `admin:false`, which counts as a
  change (Save enabled) on a new user (`users-edit.tpl.html:24-25`, `edit.js:74-76`).
- **L30. Save.** New → `POST`, existing → `PUT` (L2). Success: navigate to `/admin/users` and show there
  "A user with id '<id>' was saved successfully." (`admin-users-edit.js:13-16`, `app/app.js:23`).
  Failure: stay, show "Something went wrong when saving a user..." (`admin-users-edit.js:18-20`, `app/app.js:26`).
- **L31. Remove from edit page.** Only for existing users (L9). Success: navigate to the list and show
  "A user with id '<id>' was removed successfully." (`admin-users-edit.js:22-25`). The id comes from the
  DELETE **response** body. Failure: shows the **save** error text "Something went wrong when saving a
  user..." (there is no `onRemove` error; `onError` is shared, `edit.js:52`, `:66`).
- **L32. Non-admin writes.** If a write reaches the server without admin rights it gets 401 → login modal
  (L7); after logging in as an admin the request is retried automatically.

### Admin projects (`/admin/projects`, `/admin/projects/new`, `/admin/projects/:itemId`)

- **L33. Guard.** All three require an admin, same behaviour as L20 (`app/admin/projects/admin-projects.js:15-28`).
  New/edit also load **all users** (`:10-12`, `:21`, `:26`).
- **L34. List** (`projects-list.tpl.html`). Table (same classes) with "Name", "Description". Row click →
  edit (`:9`). No Remove button, no empty-state row. Well with "New Project" (`btn`) (`:15-17`).
- **L35. Edit form layout** (`projects-edit.tpl.html`). `div.well > form` (**no** `novalidate`), legend
  "Project", `row-fluid` with two `span6` columns. Left: "Name" (text, required, autofocus, `span10`),
  "Description" (textarea rows 10, not required, `span10`). Right (`TeamMembersController`): "Product Owner"
  select (required, placeholder "-- choose --"), "Scrum Master" select (required, "-- choose --"),
  "Development Team" table (headers "User", blank) with one row per member (name + "Remove"
  `btn btn-small`) and a final row with a member select (no placeholder option) and "Add" (`btn btn-small`,
  disabled until a member is selected). Then `<hr>` and crud buttons (L9) in a second `row-fluid`.
  No validation messages exist on this form; Save simply stays disabled.
- **L36. User labels** in all three selects and the team table are "`lastName firstName (email)`"
  (`common/resources/users.js:5-7`).
- **L37. Candidate rules** (`common/resources/projects.js:11-27`, `admin-projects.js:62-78`):
  - Product Owner candidates: users who are **not** the Scrum Master and **not** on the dev team.
  - Scrum Master candidates: users who are **not** the Product Owner (the SM *may* also be a dev).
  - Dev team candidates: users who are **not** the Product Owner and not already on the team.
  - Lists recompute live, so picking someone in one role removes them from the conflicting lists.
    The `usersLookup` check in each filter is always true (redundant).
- **L38. Team add/remove.** "Add" appends the selected user id and clears the selection
  (`admin-projects.js:82-87`); "Remove" deletes that id and clears the selection if it was the same user
  (`:89-98`). `teamMembers` is initialised to `[]` if missing (`:54`). Ids of deleted users show as an empty
  name cell (Angular expressions swallow the missing lookup).
- **L39. Enter-key quirk.** The team "Remove"/"Add" buttons have no `type`, so they are submit buttons
  (`projects-edit.tpl.html:35`, `:43`). Pressing Enter in the Name input triggers the **first** of them:
  with team members, the first member is removed; with none, "Add" fires if a member is selected.
- **L40. Save.** New → POST, existing → PUT. Success: go to `/admin/projects` and show "A project with id
  '<id>' was saved successfully." (`admin-projects.js:42-45`, `app/app.js:27`). Failure: "Something went
  wrong when saving a project..." on the same page (`:47-49`, `app/app.js:29`).
- **L41. Remove (edit page only).** The screen defines no `onRemove`, so removal falls back to `onSave`:
  after deleting it navigates to the list and shows **"A project with id '<id>' was saved successfully."**
  The message `crud.project.remove.success` ("…was removed successfully.") is defined but never used
  (`app/app.js:28`, `edit.js:50`). Failure: the save-error text. No cascade: the project's backlog items,
  sprints and tasks stay in the database.
- **L42. Revert** restores name, description, PO, SM and team list (the team controller reads the reverted
  copy through scope inheritance) (`edit.js:59-63`).

### Projects list (`/projects`)

- **L43. Guard and data.** Requires a logged-in user (any role) (`app/projects/projects.js:12`); anonymous →
  login modal "You must be logged in…", cancel → `/projectsinfo`. Shows **all** projects, not only the
  user's (TODO at `:9`).
- **L44. Table** (`projects-list.tpl.html`): headers "Name" (`span3`), "Description" (`span5`),
  "My Role(s)" (`span2`), "Tools" (`span2`), same table classes. Clicking the Name or Description cell opens
  the product backlog (`:12-13`). Tools: two links "Product backlog" and "Sprints" (anchors with **no
  href**, so no pointer/keyboard focus) → `/projects/<id>/productbacklog` / `/projects/<id>/sprints`
  (`:16-17`). No empty-state row. The same template is reused on `/dashboard` (`app/dashboard/dashboard.tpl.html:2`).
- **L45. "My Role(s)" renders the raw array as JSON**: `["PO"]`, `["SM"]`, `["DEV"]`, `["SM","DEV"]` or `[]`
  (interpolating an array calls `toJson`, `vendor/angular/angular.js:7313-7317`). A PO gets only `PO`
  even if also SM/dev; otherwise SM and DEV can combine (`common/resources/projects.js:30-43`). Uses the
  current user's `id` from `/current-user` (`projects.js:32-36`, `server/lib/security.js:10`).

### Product backlog (`/projects/:projectId/productbacklog`, `/new`, `/:itemId`)

- **L46. No client guard.** None of the three routes has an auth resolve
  (`app/projects/productbacklog/productbacklog.js:16-37`); anonymous users can view the list and open forms.
  Writes then 401 → login modal "You must be logged in…" → after login the write is retried and completes
  (L7). Any logged-in user (not only project members) may write (L5).
- **L47. List** (`productbacklog-list.tpl.html`): `GET productbacklog?q={"projectId":"<id>"}` (unsorted,
  `common/resources/backlog.js:5-7`). Headers "Name", "Description", "Priority", "Estimation". Row click →
  edit. Empty: one row "No items in the backlog" (colspan 4). Well with "New backlog item" (`btn`). The
  project id is not validated: an unknown project shows the empty list.
- **L48. Edit form** (`productbacklog-edit.tpl.html`): `div.well`, `h4` "Product backlog item", `<hr>`, form
  with "Name" (text, required, autofocus, `span10`), "User story" (textarea rows 8, required), "Priority"
  (number, required), "Estimation" (number, required), `<hr>`, crud buttons. **No validation messages at
  all**; Save stays disabled. A new item starts as `{projectId: <route id>}` (`productbacklog.js:26-28`).
- **L49. Save/Remove/Error** (`productbacklog.js:58-66`): success → back to the list **with no message**
  (TODO). Remove → falls back to onSave → back to the list, no message. Error → sets `updateError`, which
  the template never displays: **failures are silent**.
- **L50. Item from another project.** The edit route loads the item by id only; it never checks that
  the item belongs to `:projectId`, and Save/Remove return to the URL's project list (`productbacklog.js:34-36`, `:60`).

### Cross-cutting data quirks

- **L51. Deleting a user leaves dangling ids** in projects (PO/SM/team). The project form then shows an
  empty name in the team table (L38), and the selects cannot display the missing user.
- **L52. Admin pages expose passwords to the browser** (L6): the users list, the project form's users
  list and the uniqueness check all receive full user documents including `password`.
- **L53. Duplicate emails lock both users out** (client-only uniqueness L27 + exactly-one lookup L18).
