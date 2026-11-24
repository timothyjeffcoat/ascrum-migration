# Worklog: cluster p5-store (Phase 5, wave A)

## 2026-11-23, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`. Wave A has no prerequisite in
spec §4 (it is the first wave); `MIGRATION.md` has no Phase 5 rows yet, so the orchestrator's launch is
the gate. Branch `convert/p5-store` from `migration` at `bbf73a5`, in its own worktree.

### What was done
- **`handle()` is async over two interfaces** (spec §3.1).
  - `web/stub/store.ts`: `Store` (`list`, `get`, `insert`, `replace`, `remove`, `usersByEmail`,
    `reset`) and `MemoryStore`, which is today's behaviour. Its `collections` array stays public and
    `findById()` still returns the live document, because two component tests outside this cluster
    (`Dashboard.test.tsx`, `TaskEdit.test.tsx`) seed scenarios by editing the arrays. Their code is
    unchanged.
  - `web/stub/session.ts`: `Sessions` (`get`, `create`, `setUser`, `clear`) and `MemorySessions`.
  - `web/stub/query.ts`: `parseQuery()` returns a structured query (`eq` / `idIn` conditions) instead of
    a predicate. `matches()` is the reference semantics (strict `===`); PgStore translates the same
    structure to SQL.
  - `handlers.ts`: `await`s the store and sessions; S8 (keep password) and D7 (strip password) stay in
    the handler, so both stores share them. The adapters (`msw.ts`, `server.ts`) only gained `await`.
  - `src/test/stubControl.ts`: `resetStub()` stays synchronous (`reseed()` and `map.clear()`), because
    tests call it and then edit the store on the next line.
- **One contract suite, two stores** (AC-PG-01). `stub/handlers.test.ts` moved to
  `stub/contractTests.ts` as `defineContractTests(backend)` and `defineNodeAdapterTests(backend)`.
  `stub/handlers.test.ts` runs them with `describe.each([memoryBackend])`, and `api/src/pgStore.test.ts`
  runs the same functions on `pgBackend`. The test bodies are the old ones with `await` added; no
  assertion was dropped. AC-STUB-15's last line compared two in-memory store objects, which only the
  memory store has; it now compares the raw response bodies of every collection (stronger: byte level).
- **Store parity tests (new, both stores).** I listed what the in-memory arrays gave for free and a
  database does not, and wrote a test for each one *before* writing PgStore:
  1. list order is insertion order, and a PUT keeps the document's place (Postgres returns rows in any
     order without `ORDER BY`, and an `UPDATE` can move a row physically);
  2. values come back exactly as sent: `null` vs absent, a string where the schema has a number, a
     non-hex id, nested values, unknown fields, unicode, `0.1 + 0.2`, `1e300`;
  3. an absent list, `[]`, `null` and a non-list `teamMembers`/`sprintBacklog` are four different
     things; duplicates and order inside a list survive;
  4. deletes never cascade or refuse; references are left dangling (D13);
  5. `q` equality is strict (`1` is not `"1"`) and reaches unknown and odd-typed fields;
  6. one id counter shared by all collections;
  7. login takes the first matching user in insertion order; deleting the signed-in user signs them out.
- **`api/` package** (Q-p5-1 (b)):
  - `migrations/001_initial_schema.sql`: the tables of spec §3.2, `char(24)` ids with a hex CHECK, join
    tables with a `position`, a `has_*` flag per list, `jsonb extra`, `seq` for order, and a
    `wire_id_counter` sequence. The file's header comment explains every choice.
  - `src/migrate.ts`: the runner. Numbered `.sql` files, one transaction each with its
    `schema_migrations` row, an advisory lock so two containers starting together do not race.
    Also a CLI (`node api/src/migrate.ts`).
  - `src/schema.ts`: the translation layer. One rule: a value goes into its typed column only if the
    column gives back exactly the same JSON value; anything else goes into `extra` under its wire name.
    Fields come back in the seed's field order, so seed documents read back byte for byte.
  - `src/pgStore.ts`: `PgStore`. Every value, including `q` field names, is a bind parameter; the only
    text spliced into SQL is table and column names from the constant map in `schema.ts`.
  - `src/pgSessions.ts`: `PgSessions` on the `sessions` table.
  - `src/main.ts`: the API, which is the stub's Node adapter (`startStubServer`) with a PgStore and
    PgSessions. It migrates on start and seeds only a database it has just created, so a restart keeps
    data and sessions. `/__stub/reset` exists only with `ALLOW_RESET=1` (§3.3).
  - Tests: `pgStore.test.ts` (AC-PG-01, -03, -04, -05, DEV-p5-store-04), `migrate.test.ts` (AC-PG-02),
    `main.test.ts` (AC-PG-06). `testDb.ts` gives every context its own PostgreSQL schema
    (`search_path`), so test files run in parallel on one server, and drops them afterwards.
- `compose.yaml` at the repo root: only `db` (postgres:18-alpine, `127.0.0.1:55436`).
- CI: an `integration` job with a Postgres service container (Q-p5-8 (a)) running `pnpm test:integration`.

### Decisions
- **How `api/` is covered by the same gates (smallest change that works).** A root
  `pnpm-workspace.yaml` with packages `web` and `api` and `sharedWorkspaceLockfile: false`. I tried the
  alternatives first:
  - Extending web's configs alone does not work. `pg` must be resolvable from `api/` files, by Node at
    run time and by `tsc`, and Node looks in `api/node_modules`, never in `web/node_modules`.
  - A shared root lockfile would move `web/pnpm-lock.yaml`, which CI's `setup-web` action (not my path)
    uses as its cache key.

  With per-package lockfiles, CI's unchanged `pnpm install --frozen-lockfile` in `web/` installs `api/`
  too (checked: deleted both `node_modules`, ran it, and `api/node_modules/pg` appeared), and
  `web/pnpm-lock.yaml` did not change at all. Then:
  - **lint:** `eslint . ../api` and `prettier --check . ../api`. ESLint 10 looks for a config next to
    each file, so `api/eslint.config.js` is a one-line re-export of `web/eslint.config.js`. Prettier
    reads web's `.prettierrc.json` through `"prettier"` in `api/package.json`. I checked that the gate
    bites in `api/`: a planted `it.only` and an `eslint-disable-line` were both reported, and a
    double-quoted string failed Prettier.
  - **typecheck:** `web/tsconfig.json` includes `../api/src`; one `tsc` run, same strict options.
  - **tests:** Vitest projects in `web/vitest.config.ts`: `unit` (unchanged settings) and `integration`
    (`../api/src/**/*.test.ts`, node environment). `pnpm test` = `--project unit`, so the existing
    `test` job needs no database. `pnpm test:integration` = `--project integration`. `pnpm verify` runs
    both.
  - **`vitest: link:../web/node_modules/vitest`** in `api/package.json`: `api/` test files import
    `vitest`, and `tsc` resolves that from `api/`. A second copy of Vitest would load a second module
    instance at run time (Vitest needs one), so the link points at web's copy. Same realpath, checked.
- **No foreign keys between documents** (DEV-p5-store-01, Q-p5-store-1, not blocking): the spec names
  only the sprint backlog case. Any other foreign key changes what a delete does.
- **PostgreSQL 18** (Q-p5-2: the newest major RDS supports). As of this session the latest AWS
  announcements I found put PostgreSQL 19 only in the RDS *Database Preview Environment* (Beta 1
  June 2026, Beta 3 August 2026); I found no general-availability announcement. 18 is used in compose
  and CI. If 19 is GA on RDS by wave C, bumping the image tag in two places is the whole change.
- **Numbers are `double precision`**: JavaScript numbers are doubles, MongoDB stored doubles, and the
  forms never limited them to integers. Sprint `start`/`end` are `text`: the wire carries free-text
  dates (D12), and a `date` column would rewrite or refuse them.
- **Ordering:** `seq bigint GENERATED ALWAYS AS IDENTITY`, `ORDER BY seq` everywhere, PUT is an
  `UPDATE` (never delete + insert).
- **Ids:** `idFromCounter()` moved into `store.ts` and is shared; Postgres keeps the counter in a
  sequence, restarted by reset. The storability check runs before `nextval`, so a refused write does not
  use up an id.

### Proposed deviation rows (the reviewer writes `spec/deviations.md`)
Format per `conversion-spec.md` §8.4. "Caught by" is the worker, at design time.
- `DEV-p5-store-01 | §3.2 / D13 | No foreign keys between documents, not just on sprint_backlog_items.backlog_item_id; only join table → owner (ON DELETE CASCADE). A FK would make deletes fail or cascade, which the stub and MongoDB never did | worker (design) | non-blocking | comment in 001_initial_schema.sql; contract test "D13: deletes never cascade or refuse"; Q-p5-store-1 | this PR`
- `DEV-p5-store-02 | §0 "byte for byte" | Key order of a document created or replaced through the API: Postgres answers _id first, then the known fields in seed order, then unknown fields in jsonb key order. The memory store answers the keys in the order the client sent them, with _id last on a POST. JSON key order carries no meaning and the front end parses the body; seed documents are byte-identical (AC-PG-03) | worker (design) | non-blocking | comment in schema.ts; contract tests compare parsed values | this PR`
- `DEV-p5-store-03 | §3.1 | One sessions row per request that arrives without a valid sid (the memory Map did the same, but a table outlives the process). Nothing expires them yet; p5-security or p5-containers should add expiry or cleanup | worker (design) | non-blocking | noted for wave B | this PR`
- `DEV-p5-store-04 | §3.1 | PostgreSQL text/jsonb cannot hold a NUL character, and UTF-8 cannot hold a lone UTF-16 surrogate. The memory store accepted both. PgStore refuses such a write and handle() answers 400 {message} instead of storing something else | worker (design) | non-blocking | assertStorable() in pgStore.ts; test "DEV-p5-store-04: …" | this PR`

### Contract tests that failed against PostgreSQL before they passed
**None.** The first `pnpm test:integration` run against the local database was 35/35 green. That is
not proof the tests bite, because the risks were known before PgStore existed (the parity tests above
were written first and run against the memory store). So I ran deliberate mutations of PgStore and the
schema, one at a time, and restored the files after each (`diff -r` against a backup: clean):

| # | Mutation | Result |
|---|---|---|
| M1 | drop `ORDER BY t.seq` | caught: "lists in insertion order …" |
| M2 | an empty list is no longer stored as a list (flag only for non-empty) | **survived**, and correctly: `[]` then goes into `extra` and still round-trips. An equivalent mutation, not a gap |
| M2' | ignore the `has_*` flag when reading | caught: "D13: an absent list, an empty list and a non-list value …" |
| M3 | string-built SQL for column equality (`= '${value}'`) | caught: AC-PG-05 |
| M4 | foreign key on `sprint_backlog_items.backlog_item_id` | caught: the seed cannot load, so almost every test fails, plus AC-PG-02's foreign-key listing |
| M5 | `tasks.sprint_id REFERENCES sprints ON DELETE CASCADE` | caught: "D13: deletes never cascade …" and AC-PG-02 |
| M6 | PUT as DELETE + INSERT (row moves to the end) | caught: "lists in insertion order …" |
| M7 | the API keeps sessions in memory (`MemorySessions`) | caught: AC-PG-06 |
| M8 | no storability check | caught: DEV-p5-store-04 (Postgres raises, the API would answer 500) |

### Mistakes and wrong turns
- First version of the strict-equality parity test used `BACKLOG.push.toUpperCase()` as "an id that
  differs only in case". The seed ids are all digits, so upper-casing changed nothing and the memory
  store (correctly) matched it. Test bug, caught on the first memory run; now it upper-cases a generated
  `f…` id. I made the same slip in a round-trip value (`PROJECT.webshop.toUpperCase()`), now an explicit
  `'ABCDEF' + '0'.repeat(18)`.
- The first `integration` include pattern was `../api/**/*.test.ts`. It picked up the test files that
  ship inside `api/node_modules/.pnpm/pg*`, and adding `exclude: ['**/node_modules/**']` did not filter
  paths that start with `../`. Narrowed to `../api/src/**/*.test.ts`.
- I first used `String.prototype.isWellFormed()` for the lone-surrogate check. It is ES2024 and the
  tsconfig `lib` is ES2023. I did not raise `lib`; a `/\p{Cs}/u` regex does the same. My first regex
  also contained `\u0000`, which ESLint's `no-control-regex` rejected, so NUL is now checked with
  `includes('\u0000')`.
- I put `memoryBackend` in `handlers.test.ts` and imported it from `adapters.test.ts`. Importing a test
  file runs its `describe` again in the importing file, so I moved it to `contractTests.ts` before it
  was committed.
- `tsc` could not resolve `vitest` from `api/` files (Vitest itself could at run time). I considered a
  `paths` mapping and re-exporting Vitest from web; the `link:` dev dependency was the least surprising.

### Notes for later clusters (not done here, not my paths)
- **p5-security:** `POST /__stub/reset` on the API without `ALLOW_RESET=1` answers **403** to a
  client without the XSRF header (the XSRF check runs before routing), and 404 to one with it.
  AC-SEC-03 asks for 404, so that test should send a valid session and XSRF header, or the reset route
  check should move. Login now goes through `store.usersByEmail()` and compares passwords in
  `handle()`, which is where hashing (S-p5-1) slots in. The plain-text `users.password` column is
  commented as such.
- **p5-containers:** `api/` imports the shared contract from `web/stub/` (`handlers.ts`, `server.ts`,
  `store.ts`, `session.ts`, `query.ts`, `seed.ts`), so the API image's build context must include those
  files as well as `api/`. Run `node api/src/main.ts` with `DATABASE_URL`, `PORT` and optionally
  `ALLOW_RESET=1`. `compose.yaml` has only `db`, with a named volume, and the host port can be moved
  with `DB_PORT`.
- **CI cache:** `setup-web` keys the pnpm cache on `web/pnpm-lock.yaml` only, so a change to
  `api/pnpm-lock.yaml` does not refresh the cache. That only makes the cache less useful; installs are
  still `--frozen-lockfile` and correct.

### Gate results (run in this session, from `web/`, with `STUB_PORT=3601 PREVIEW_PORT=4773 PAGES_PORT=4774` and `DATABASE_URL` pointing at the compose db on 55436)
- `pnpm test:integration` with `DATABASE_URL` unset: all 3 files fail with "pnpm test:integration needs a
  PostgreSQL database in DATABASE_URL …", exit 1 (fails loudly, does not skip).
- `pnpm verify` → exit 0:
  ```
  $ eslint --max-warnings 0 . ../api && prettier --check . ../api
  All matched files use Prettier code style!
  $ tsc --noEmit -p tsconfig.json
  $ vitest run --project unit
   Test Files  41 passed (41)
        Tests  413 passed (413)
  $ vitest run --project integration
   Test Files  3 passed (3)
        Tests  35 passed (35)
  $ pnpm build && pnpm build:pages && playwright test
    37 passed (13.0s)
  ```
  (Unit: 406 before this cluster, +7 store-parity cases on the memory store.)

### AC → test
| AC | Test(s) |
|---|---|
| AC-PG-01 | `api/src/pgStore.test.ts` › "AC-PG-01: the stub contract (AC-STUB-01..15) and store parity, run by the same code on PgStore" (24 tests from `stub/contractTests.ts`) and "AC-PG-01: the Node adapter over PgStore" |
| AC-PG-02 | `api/src/migrate.test.ts` › "AC-PG-02: run from an empty schema to current, and running them again is a no-op"; "… two processes migrating … at once …"; "… sprint_backlog_items has no foreign key …" |
| AC-PG-03 | `pgStore.test.ts` › "AC-PG-03: after a reset, every collection reads back the same as the memory store, byte for byte" |
| AC-PG-04 | `pgStore.test.ts` › "AC-PG-04: "Legacy Cleanup" has no teamMembers …"; "AC-PG-04: the sprint backlog id of a deleted item survives a round trip, in place" |
| AC-PG-05 | `pgStore.test.ts` › "AC-PG-05: SQL in a q value or a q field name matches nothing and harms nothing"; "AC-PG-05: SQL in a login or an id is just text" |
| AC-PG-06 | `api/src/main.test.ts` › "AC-PG-06: a signed-in session, its XSRF token and the data survive an API restart" |

### Questions
- Q-p5-store-1 (foreign keys between documents): not blocking, implemented as recommended.

### Legacy-case table
Not applicable: spec §9 assigns no legacy test cases to Phase 5 clusters.

## 2026-11-23, session 2 (worker, after the review of PR #48)

**Scope:** tests only. The reviewer found the code correct and logged four test gaps
(DEV-p5-store-05..08); the owner approved closing all four before merge ("approve all", relayed by the
orchestrator). No file under `api/src` or `web/stub` other than the two test files changed:
`web/stub/contractTests.ts` (shared contract suite, both stores) and `api/src/pgStore.test.ts`.
Owner answers recorded in `spec/questions/p5-store.md`.

### Method
For each gap: apply the reviewer's breakage alone to `api/src/pgStore.ts` (or `web/stub/store.ts`), run
the suite on the branch as reviewed and see it pass, add or strengthen tests, run them against the same
breakage and see them fail, restore the source (`git checkout`), and see everything pass. The breakages
were applied by a throwaway script outside the repo (exact text replacements, nothing committed).

### Gaps closed
| Gap | Breakage (each alone) | Before (tests as reviewed) | After: red | After, code restored |
|---|---|---|---|---|
| DEV-05 / O2a | projects PUT does not rewrite `project_team_members` | integration 35/35 green | 1 failed / 38: "DEV-p5-store-05 / O2: a PUT that changes a list …" | green |
| DEV-05 / O2b | projects PUT deletes the team rows, does not re-insert | 35/35 green | 1 failed / 38 (same test) | green |
| DEV-05 / O2c | no collection's PUT rewrites its join table | 35/35 green | 1 failed / 38 (same test) | green |
| DEV-05 / O2d | every PUT clears its join rows (was already caught) | 2 failed / 35 | 3 failed / 38 (+ DEV-05) | green |
| DEV-05 / R7 | a PUT never updates `has_*` | 35/35 green | 1 failed / 38 (same test; "Legacy Cleanup" first member, and present → absent) | green |
| DEV-06 / O1c | `ORDER BY seq` for tasks only, the other tables unordered | 35/35 green | 2 failed / 38: "DEV-p5-store-06 / O1: every collection lists in insertion order …", and DEV-05 (its whole-list comparison after PUTs) | green |
| DEV-06 / O1e | `ORDER BY seq` for tasks, `ORDER BY ctid` for the rest | 35/35 green | 2 failed / 38 (same two) | green |
| DEV-07 / R15b | `usersByEmail()` built as `WHERE email = '${email}'` | 35/35 green | 2 failed / 38: "AC-PG-05: SQL in a login or an id is just text" and "DEV-p5-store-07: an e-mail that looks like SQL is only text …" | green |
| DEV-08 / R2 | case-insensitive `usersByEmail()` (`lower(email) = lower($1)`) | 35/35 green | 1 failed / 38: "DEV-p5-store-08: login matches the e-mail exactly, case included …" | green |
| DEV-08 / R2 (memory) | `MemoryStore.usersByEmail()` compares lower-cased | unit 413/413 green | 1 failed / 416 (same test, MemoryStore) | green |

### The tests
- **DEV-05** (contract suite, both stores): PUTs Webshop's team changed and reordered, then shorter;
  gives "Legacy Cleanup" its first member (absent → present); clears Mobile App's team to `[]`; removes
  Webshop's team (present → absent), then sets it to `[]` (absent → empty) and Mobile App's to `null`.
  Sprints: backlog changed (keeping the dangling id), cleared, removed, and back to present with a
  duplicate. Every PUT is read back by id and in the full list, and both collections are compared whole
  at the end, so a PUT that touches another document's list also fails.
- **DEV-06** (contract suite): replaces "lists in insertion order, and a PUT keeps the document in its
  place", which covered tasks only. For each of the five collections it edits the first and a middle
  document, adds one, and expects the original order plus the new id last. Also a filtered list
  (Webshop's backlog) after the edits. R1 (join items without `position` in their `ORDER BY`) still has
  no test, as the reviewer logged: heap order equals position order for every write this code makes.
- **DEV-07**: `INJECTED_EMAILS` (in `contractTests.ts`) holds five e-mails that each sign in as the admin
  on a string-built lookup when sent with the admin's real password, including the reviewer's
  `nobody' OR email = 'admin@abc.com`. Asserted in the named AC-PG-05 test (PgStore) and in a new
  contract test (both stores): `{user:null}`, and `/current-user` is `{user:null}` afterwards.
- **DEV-08**: legacy pins it. `legacy/server/lib/mongo-strategy.js` `findByEmail` sends
  `q={"email": email}` to MongoLab, which is MongoDB equality (exact, case-sensitive string
  comparison), and nothing on the way lower-cases or trims (passport-local passes the field through;
  `LoginFormController.js` sends what was typed). So no `Q-p5-store-2`. The contract test: the admin's
  e-mail in three other cases and with a leading or trailing space signs nobody in; `q` on `users` with
  the upper-case e-mail finds nothing; a user created as `Mixed@Case.test` signs in only with that exact
  spelling. Runs on both stores.

### Dependabot `/api` (Q-p5-devsecops-5)
Pending. `.github/dependabot.yml` arrives with PR #41, which is still open (not merged into `migration`
at the end of this session, checked with `gh pr view 41`). When it merges, the `/api` npm entry needs
adding next to the existing ones (owner: it lands with `api/`).

### Mistakes and wrong turns
- My first DEV-06 draft expected Webshop's filtered backlog without "Wish list" (I counted five Webshop
  items from memory; the seed has six). Caught by reading `seed.ts` before the first run.
- A heredoc in a shell command that wrote the breakage script was refused by a tool safety check; I
  wrote the script with the editor instead. No effect on the repo.

### Gate results (run in this session, from `web/`, with `STUB_PORT=3601 PREVIEW_PORT=4773 PAGES_PORT=4774` and `DATABASE_URL` pointing at the compose db on 55436)
`pnpm verify` → exit 0:
```
$ eslint --max-warnings 0 . ../api && prettier --check . ../api
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
$ vitest run --project unit
 Test Files  41 passed (41)
      Tests  416 passed (416)
$ vitest run --project integration
 Test Files  3 passed (3)
      Tests  38 passed (38)
$ pnpm build && pnpm build:pages && playwright test
  37 passed (13.4s)
```
(Unit 413 → 416 and integration 35 → 38: three new contract tests, DEV-05, -07 and -08; the DEV-06 test
replaces the tasks-only order test.)
