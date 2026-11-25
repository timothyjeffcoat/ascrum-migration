# CLAUDE.md: AScrum migration (AngularJS 1.2 → React 19)

This repo (public: `ascrum-migration`) is a portfolio artifact. The product is the **workflow** (spec, gates, honest logs) as much as the code. Read this file fully at the start of every session.

## Sources of truth
1. `spec/conversion-spec.md`: **the contract.**
   - Roles (top of the file); decisions (§0, sign-offs §0.1); layout (§3).
   - Architecture, including composition, the `useCrudForm` contract and the route-file contract (§4).
   - Mapping (§5); defect dispositions (§6); stub (§7).
   - Clusters, ownership and workflow (§8); test porting (§9); acceptance criteria (§12); Phase 2 (§13).
   - **If its status line doesn't read APPROVED, workers must not start.** Also check `MIGRATION.md`: your cluster's wave gate (spec §8.1) must be open.
2. `spec/inventory.md`: facts about the legacy app. `legacy/` is the reference source; never modify it.
3. `spec/questions.md` (owner answers) and `spec/questions/<cluster>.md` (Phase 3 questions).
4. `MIGRATION.md`: cluster status. Reviewers change it, and only through PRs (spec §8.2/§8.3).

## Non-negotiable rules
- **If the spec is silent, ask; don't guess.** Append to `spec/questions/<your-cluster>.md` with id `Q-<cluster>-<n>` (context, options, recommendation). Mark the item blocked in your worklog and continue with unblocked work. If nothing is unblocked, commit, push your branch, and stop. The orchestrator relays the answer and relaunches you (spec §8.5).
- **Never report done without passing gates.** "Done" means the Definition of Done below is met *and you ran the commands in this session*. Quote actual results.
- **Stay inside your cluster's owned paths** (spec §8.1). Every cluster may also write its own `spec/worklogs/<cluster>.md` and `spec/questions/<cluster>.md`. Anything else outside the owned paths becomes a question, never an edit.
- **Don't add dependencies** without an answered question.
- **Don't change the wire contract.** Quirks live only in `api/` and `auth/` (spec §4).
- **Never weaken a gate:** no skipped or `.only` tests, `eslint-disable`, `@ts-expect-error`, `as any`, or loosened configs. If a gate seems wrong, ask. Most of these are enforced mechanically (inline eslint config is off, `.only/.skip/.todo` and `@ts-*` comments are lint errors), and editing the config to get around them is a blocking deviation.
- **Honesty over polish.** Record mistakes, reverts and wrong turns in your worklog; they feed `spec/deviations.md` and the public case study.
- **This repo is public.** Never write absolute local paths, usernames, emails or secrets into tracked files.

## Stack and commands (run from `web/`)
Node 24 LTS, pnpm, React 19, TypeScript strict, Vite, react-router v7 (data mode), Vitest + Testing Library + MSW, Playwright.

| Gate | Command |
|---|---|
| lint | `pnpm lint` (eslint with `--max-warnings 0` + prettier --check) |
| typecheck | `pnpm typecheck` |
| unit | `pnpm test` |
| build | `pnpm build` |
| e2e | `pnpm e2e`: builds `dist/` and `dist-pages/` first, then Playwright (Chromium, serial), project `chromium` (Node stub + `vite preview`) and `pages` (Pages build + MSW) |
| e2e, watching | `pnpm exec playwright test --headed`, `--ui` (time-travel UI) or `--debug` (step through); needs a display, so local only |
| all gates, as CI runs them | `pnpm verify` |
| dev | `pnpm dev` (Node stub via proxy) / `pnpm dev:msw` (in-browser stub) |
| one-off stub | `pnpm stub` (port 3001); `POST /__stub/reset` reseeds |

Node comes from `web/.nvmrc` (`nvm use`), pnpm from `packageManager` (`corepack enable`).

**Parallel worktrees:** `STUB_PORT`, `PREVIEW_PORT` and `PAGES_PORT` (defaults 3001/4173/4174) move every e2e server.
Cluster `n` exports `STUB_PORT=3001+100n PREVIEW_PORT=4173+100n PAGES_PORT=4174+100n` before `pnpm verify`/`pnpm e2e`. For example, cluster 2 uses 3201/4373/4374.

## Conventions
**Layout and routes**
- Feature code goes in `web/src/features/<feature>/`.
- `routes.tsx` exports `export const routes: RouteObject[]` with **flat absolute paths**, built with `crudRoutes()` where it fits (spec §4.3).
- Tests sit next to the code as `*.test.ts(x)`.
- `stub/` and `scripts/` run directly under Node 24 (type stripping): relative imports there carry their `.ts` extension, and only erasable TypeScript syntax is allowed (no enums, no constructor parameter properties). `tsc` enforces this everywhere.

**Naming**
- Components and component files: `PascalCase.tsx`. Hooks: `useThing.ts`; anything that calls a hook *is* a hook and is named `use*`. Other modules: `camelCase.ts`.
- Name units after the spec §5 mapping table so the reviewer can diff mapping → file.

**React style: boring on purpose**
- Function components only. The single exception is the `RootErrorBoundary` class.
- Data comes from route **loaders** (`useLoaderData`); no fetching in `useEffect`. Await guards at the top of loaders.
- Forms use `useCrudForm` exactly as specified in §4.2. "New" forms start from the §5.6 drafts.
- No global state library. Context only for auth.
- Explicit props types; no `React.FC`; no default exports unless a tool requires one.
- Keep the legacy Bootstrap 2 markup, class names and UI strings verbatim (spec B4). One standing exception: every form `<label>` gets `htmlFor` and its control an `id` (spec §0.2 P1).
- Every `<form>` has `onSubmit={(e) => e.preventDefault()}` (or a handler that starts with it), and every `<button>` inside it is `type="button"`. The one exception is the login modal's "Sign in" (`type="submit"`, spec §0.2 P4). Test that Enter in a text field does not submit.
- Keep `<LoginModal/>` outside `RouterProvider` and keep the root route's `HydrateFallback`: a single test (`src/app/routerDataMode.test.tsx`, §11-4) guards this composition.
- Role and candidate logic comes from `domain/` only.
- Comments explain *why*, especially wherever behaviour deliberately differs from legacy (cite the D-id or S-id).

**Tests**
- Every AC your cluster owns (spec §12) has at least one test whose name starts with the id, e.g. `it('AC-TSK-03 / D6: saving returns to the sprint task list', …)`. Every **fixed** defect with the "named test" rule (spec §6) has a test naming its D-id.
- Every screen has at least one assertion on its legacy root classes (spec §12 class-parity rule). No snapshot tests.
- Port every legacy case assigned to your cluster (spec §9) using the statuses defined there. Respect the pre-assigned statuses. Record each case in your worklog table.
- Use the shared helpers in `src/test/`:
  - `const { user, router } = await renderRoute(path, {as: 'admin' | 'po' | 'sm' | 'dev1' | 'dev2' | 'outsider' | 'anonymous'})`. It is async (it signs the persona in on the stub first; Q-foundation-2). Before touching anything in the header (nav, Admin menu, Log in/out, breadcrumbs), `await waitForShell(router)`: the shell re-mounts once the first load completes, and `router.state.initialized` alone flips too early (DEV-foundation-06). Screen content (a table, a form) only exists in the real shell, so `findByRole` on it is enough;
  - `recordRequests()` to see what reached the stub without mocking `api/`;
  - `resetStub()`, which runs automatically before each test;
  - `failNext(method, pathPattern, status)` for error paths.

  Per-test `server.use()` overrides are allowed for error injection. Mocking `api/` is not.
- Query by role, label or text, via Testing Library.
- Each e2e file starts with `POST /__stub/reset`, except `e2e/pages/` (no reset route in the Pages build; every page load is a fresh in-browser stub). Playwright runs serially and never reuses a running server, so stop `pnpm dev` before `pnpm e2e`.

## Definition of done (worker)
1. All of the cluster's AC tests and named defect tests exist and pass.
2. The legacy-case table in the worklog is complete for the cluster's §9 rows.
3. `pnpm verify` is green in this session; paste the summary lines into the worklog.
4. The cluster's e2e file covers its screens and passes.
5. `git diff --stat origin/migration...HEAD` shows only owned paths plus the cluster's worklog and questions files.
6. The branch is pushed, and a PR into `migration` is open, listing the ACs covered and linking the worklog.
7. **Stop.** CI, review, `MIGRATION.md` and merging belong to the reviewer.

## Logs
- `spec/worklogs/<cluster>.md` (worker): a dated entry per session covering what was done, decisions, blockers, questions, mistakes and wrong turns, and the gate results actually run. It also holds the legacy-case table.
- `spec/deviations.md` (reviewer): format and cluster-scoped ids in spec §8.4.
- `spec/journal.md` (reviewer and orchestrator): written for a LinkedIn article aimed at engineering managers. Cover what happened, decisions and why, measured metrics only (cite `spec/metrics.jsonl`, `gh`, `deviations.md`), and "moments".
- `spec/metrics.jsonl` is written by the `.claude/settings.json` hook into the main checkout. Never edit it by hand or disable the hook.
- The hook records pass/fail from the command's **exit code**. Run gate commands unpiped, or start with `set -o pipefail`; `pnpm test | tail` always "passes" (this undercounted Phase 2's failures, see the journal).

## Reviewer role
Reviewers: read `.claude/rules/review.md` in full before starting (spec §8.2 checklist, the gate `rg` check, logging, merging, the security second review).

## Git
- Workers: branch `convert/<cluster>` from `migration` in their own worktree. Make small commits, each ending with the attribution trailer the session provides.
- Changes reach `migration` only through PRs. Never force-push a shared branch, and never rewrite `master` (the legacy snapshot).
- Never commit secrets or `.env` files.
