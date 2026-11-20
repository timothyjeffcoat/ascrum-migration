# Spec review 1: independent team-lead review of conversion-spec (rev 1)

- **Date:** 2026-11-20
- **Reviewer:** a fresh general-purpose sub-agent with no access to the authoring session's context. It was briefed as a team lead about to hand the spec to three parallel workers, with read-only access to the spec, CLAUDE.md, inventory, questions and legacy source. It was told not to re-litigate owner decisions.
- **Effort:** 29 tool calls, about 9 minutes, about 201k tokens (from the agent's completion notice).
- **Verification:** the authoring session re-checked every factual claim against the legacy source before acting. Design-reasoning findings were judged on their merits.

## Outcome
| | Count |
|---|---|
| Findings raised | 25 (9 blocking, 11 important, 5 minor) |
| Confirmed and fixed in spec rev 2 | 25 |
| Rejected | 0 |
| Escalated to owner as new sign-off items | folded into §0.1 of rev 2 (R-18) |
| Claims the reviewer verified as correct | 19 groups (test counts, message keys, routes, D3/D6/D13/D21, UI strings, server contract, …) |

## Findings and disposition

| ID | Sev. | Finding (short) | Verified how | Fix in rev 2 |
|---|---|---|---|---|
| R-01 | blocking | Worklogs, questions and e2e files sit outside every cluster's owned paths, so a literal reading fails every PR | design | §8.1 "every cluster may also write" row |
| R-02 | blocking | A shared questions.md is unworkable across isolated worktrees (id clashes, no answer/resume protocol) | design | §8.5 per-cluster question files + protocol |
| R-03 | blocking | No owner for test infra (MSW server, stub reset, render-as-user, error injection) | design | §13 Phase 2 delivers `src/test/`; cluster 0 adds `renderRoute`; overrides allowed |
| R-04 | blocking | AuthProvider/LoginModal inside the route tree deadlock a guarded deep-link reload | design (RR data mode runs initial loaders before elements mount) | §4.1 tree: providers outside RouterProvider; AC-AUTH-09 |
| R-05 | blocking | `useCrudForm` contract too thin: form-only fields, cross-field/conditional/async validators, numeric coercion, payload shaping | legacy users-edit.tpl.html:21 (`ng-model="password"`) | §4.2 full signature; AC-CRUD-09..12 |
| R-06 | blocking | Types require every field; legacy "new" creates partial docs; D13 inexpressible without casts | legacy productbacklog.js:27, sprints.js:24, tasks.js:29-33 | §5.5 optional wire fields + `Draft<T>`; §5.6 initial drafts |
| R-07 | blocking | Candidate filters have no home in `domain/`, yet CLAUDE.md forbids re-implementing them | legacy admin-projects.js:63-79 | `domain/projects.ts` candidates; AC-DOM-05 |
| R-08 | blocking | The spec invented "touched" visibility; legacy shows errors whenever invalid | **re-checked:** edit.js:101 `showError` = `form[f].$error[k]` | keep legacy behaviour; AC-CRUD-03/06 reworded |
| R-09 | blocking | Reviewer bookkeeping contradicts "no direct push to migration" plus branch protection; statuses unrecordable; stopped worker can't be re-engaged | design | §8.2/§8.3 bookkeeping on PR branch + status PR; orchestrator relaunch |
| R-10 | important | Render errors reach the route errorElement, not ErrorBoundary; root errorElement replaces the shell; rotation-vs-push ordering | design (RR behaviour; React effect order) | §4.1 layout route + `router.subscribe` rotation; AC-NOT-04/05 split by error type |
| R-11 | important | `all()` sends `q={}` in legacy, not "no q" | **re-checked:** mongolab-resource.js:45,50 | AC-API-03 corrected |
| R-12 | important | `/current-user` is re-requested while anonymous, not "once" | **re-checked:** security.js; authorization.spec.js:25 | AC-AUTH-01 rewritten; shared in-flight promise logged in §0.1 |
| R-13 | important | `listNav` calls a hook but isn't named `use*`, so lint fails | design (rules-of-hooks) | renamed `useListNav` |
| R-14 | important | Parallel Playwright files plus a shared stateful stub cause flakiness; nobody owns the full path | design | §2/§8.1: `workers: 1`, reset per file; full path owned by cluster 4 |
| R-15 | important | Phase 2 has no deliverables or exit criteria; many files unowned; cookie secret missing from removal list | **re-checked:** server/config.js `cookieSecret` | new §13 Phase 2 deliverables + exit gate; wave-A start gate |
| R-16 | important | Absolute `/static/...` asset paths break under Vite and the Pages base | **re-checked:** variables.less:133-134, header.tpl.html:20 | §11 risk 6, §13 item, AC-SHELL-05 |
| R-17 | important | Several ACs untestable (Pages deep link, CSS parity, AC-STUB n, D-rows that are drops/secrets) | design | AC-SHELL-06/07 via Playwright; AC-STUB-01..15 enumerated; D-test rule exemptions; per-screen class assertion rule |
| R-18 | important | §0.1 decisions unconfirmed, so workers would enforce unapproved items | questions.md has no sign-off | §0.1 items made explicit sign-off rows; status stays DRAFT until signed |
| R-19 | important | "113 portable" counts cases for dropped or contradicted behaviour; owner's metric was N/133 | **re-checked:** edit.spec:220-262, projects.spec:30-34, notifications.spec:29, admin-users-edit.spec:26, security.spec:97 | §9 pre-assigned statuses (8 n/a); headline metric N/133 with breakdown |
| R-20 | important | Select blank options/unassign undefined; `{{exception}}` content undefined | **re-checked:** tasks-edit.tpl.html:8,21 (no empty option) | AC-TSK-02, AC-AUTH-04; §0.1 |
| R-21 | minor | Remove failures reuse "save" error wording / unspecified | **re-checked:** edit.js:66 `$remove(onRemove, onError)` | new `*.remove.error` keys; AC-CRUD-05 |
| R-22 | minor | `api/collections.ts`, `crud/crudRoutes.ts` missing from layout; routes.tsx contract unstated | design | §3 updated; §4.3 routes contract |
| R-23 | minor | Legacy 403 body is "Forbidden"; XSRF precedes auth; retry must recompute the XSRF header | **re-checked:** xsrf.js:32 `res.send(403)`; middleware order in server.js | §7.2; AC-API-07; AC-STUB-03 |
| R-24 | minor | Right-hand backlog names also link; buttons inside forms need `type="button"` | **re-checked:** sprints-edit.tpl.html (right table `viewProductBacklogItem`) | AC-SPR-03; CLAUDE.md convention |
| R-25 | minor | LOC baseline wrong: 1,849 is JS only; JS + templates = 2,290 | **re-checked:** `wc -l` = 2,290 | §10 and inventory corrected |

## What this says about the process (journal material)
- The reviewer had a clean context and was told only *where* to look, not what the author thought. It found 9 blocking problems in a spec its author had just called ready for review.
- **Most findings were coordination failures, not React mistakes:** files nobody owns, a question channel that can't work across worktrees, bookkeeping that contradicts branch protection. Parallel agents need the *process* specified as carefully as the code.
- **Three findings were the author misreading legacy behaviour:** `q={}`, errors visible without "touched", `/current-user` re-requested. The fix for that is exactly this practice: verify against source, not memory.
