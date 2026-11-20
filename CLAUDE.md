# CLAUDE.md: AScrum migration (AngularJS 1.2 → React 19)

This repo is a public portfolio artifact. The product is the **workflow** (spec, gates, honest logs) as much as the code. Read this file fully at the start of every session.

## Sources of truth (read before working)
1. `spec/conversion-spec.md`: **the contract.** Decisions (§0), layout (§3), architecture (§4), mapping (§5), defect dispositions (§6), stub (§7), clusters and ownership (§8), test porting (§9), acceptance criteria (§12).
2. `spec/inventory.md`: facts about the legacy app. `legacy/` is the reference source; never modify it.
3. `spec/questions.md`: answered and open questions.
4. `MIGRATION.md`: cluster status. **Reviewer-only**; workers never edit it.

## The non-negotiable rules
- **The spec is silent → ask, don't guess.** Append a question to `spec/questions.md` (next free id in the right section, with context, options and a recommendation), mark the affected work as blocked in your worklog, and continue with unblocked work.
- **Never report done without passing gates.** "Done" means every item in *Definition of done* below is true *and you ran the commands in this session*. Quote the actual result; never paraphrase a run you didn't do.
- **Stay inside your cluster's owned paths** (spec §8.1). If you need a change to shared code (`app/`, `api/`, `auth/`, `notifications/`, `crud/`, `domain/`, `stub/`, config files), don't make it: raise a question.
- **Don't add dependencies.** A new package needs an answered question first.
- **Don't change the wire contract.** Quirks live only in `api/` and `auth/` (spec §4).
- **Never weaken a gate to pass it:** no skipped tests, `eslint-disable` lines, `@ts-expect-error`, `as any`, or loosened tsconfig/eslint settings. If a gate seems wrong, raise a question.
- **Honesty over polish.** Record mistakes, reverts and wrong turns in your worklog. They feed `spec/deviations.md` and the public case study.

## Stack and commands (run from `web/`)
Node 24 LTS, pnpm. React 19, TypeScript strict, Vite, react-router v7 (data mode), Vitest + Testing Library + MSW, Playwright.

| Gate | Command |
|---|---|
| lint | `pnpm lint` (eslint + prettier --check) |
| typecheck | `pnpm typecheck` |
| unit | `pnpm test` (vitest run) |
| build | `pnpm build` |
| e2e | `pnpm e2e` (Playwright against the Node stub) |
| all gates, as CI runs them | `pnpm verify` |
| dev (Node stub via proxy) | `pnpm dev` |
| dev (in-browser MSW stub) | `pnpm dev:msw` |

## Conventions
**Layout:** feature code goes in `web/src/features/<feature>/`. Each feature exports its route objects from `routes.tsx`; that file is the only one `app/router.tsx` imports. Tests sit next to the code as `*.test.ts(x)`.

**Naming**
- Components and component files: `PascalCase.tsx`. Hooks: `useThing.ts`. Other modules: `camelCase.ts`.
- One component per file, plus small private helpers.
- Name units after the spec §5 mapping table (e.g. `BacklogItemEdit.tsx`), so the reviewer can diff mapping → file.

**React style: boring on purpose**
- Function components and hooks. No class components except `ErrorBoundary`.
- Data comes from route **loaders** (`useLoaderData`). No `useEffect` fetching. Guards are awaited at the top of loaders.
- Local state goes in `useState`/`useCrudForm`. No global state library. Context only for auth.
- Explicit props types. No `React.FC`. No default exports except where a tool requires them.
- Keep the legacy Bootstrap 2 markup and class names (spec B4), since visual parity depends on them. Use the legacy UI strings verbatim.
- Domain rules come from `domain/`; never re-implement role or candidate logic inside components.
- Comments explain *why*, especially wherever behaviour deliberately differs from legacy (cite the D-id).

**Tests**
- Every acceptance criterion your cluster owns (spec §12) has at least one test whose name starts with the id, e.g. `it('AC-TSK-03 / D6: saving returns to the sprint task list', …)`.
- Every **fixed** defect your cluster owns (spec §6) has a test naming its D-id.
- Port every legacy case assigned to your cluster (spec §9) as *ported*, *adapted*, or *n/a + reason*, recorded in your worklog table.
- Test through the UI with Testing Library queries by role/label/text. Use MSW with the shared stub handlers for network calls, and don't mock `api/` in feature tests.
- No snapshot tests.

## Definition of done (for a worker's cluster)
1. Every AC and fixed-defect test for the cluster exists and passes.
2. The legacy case table in the worklog is complete for the cluster's §9 rows.
3. `pnpm verify` is green locally in this session (paste the summary line into the worklog).
4. If the cluster adds screens to the smoke flow: `e2e/<cluster>.spec.ts` covers them and passes.
5. No edits outside the owned paths (check with `git diff --stat migration...HEAD`).
6. The worklog is up to date. The PR into `migration` is open, its description lists the ACs covered and links the worklog.
7. You **stop** there. CI, review, `MIGRATION.md` and merging are the reviewer's job.

## Logs you must keep
- `spec/worklogs/<cluster>.md` (worker): a dated entry per working session covering what was done, decisions, blockers, questions raised, mistakes and wrong turns, and the gate results you actually ran. It also holds the legacy-case table.
- `spec/deviations.md` (reviewer only): format in spec §8.4.
- `spec/journal.md` (reviewer and orchestrator): a dated entry at the end of each phase or cluster merge. It is written for a LinkedIn article aimed at engineering managers: what happened, decisions and why, measured metrics only (cite `spec/metrics.jsonl`, `gh`, or `deviations.md`), and "moments".
- `spec/metrics.jsonl` is written automatically by the hook in `.claude/settings.json` into the **main checkout**. Don't edit it by hand. Don't disable the hook.

## Reviewer role (when you are the reviewer session)
- You are not the worker. Review against the spec, not against the worker's explanation.
- For each AC in the cluster: confirm the behaviour in the code **and** that a named test exists and asserts it. Mark it pass or fail in a PR comment checklist.
- Diff against spec §5/§6: unexpected files, missing units, any defect handled contrary to its disposition, edits outside owned paths, weakened gates.
- Log every finding in `spec/deviations.md` with *caught by* and *severity*. Blocking = an AC failing, a contract change, a gate weakened, or an edit outside the owned paths.
- Merge only when CI is green **and** 0 blocking deviations are open: `gh pr merge --squash`. Then update `MIGRATION.md` and append to `spec/journal.md`.

## Git
- Workers: branch `convert/<cluster>` from `migration`, in their own worktree. Make small commits with clear messages, ending with the attribution trailer the session provides.
- Never push to or rewrite `migration` or `master` directly. Never force-push a shared branch.
- Never commit secrets or `.env` files.
