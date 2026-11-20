# Open Questions

Status: **awaiting answers (Phase 0 gate)**. Each question has an ID, the reason it matters (with an inventory reference), options, and a recommended default.
To answer, write under `**Answer:**`. A short "default" is fine.
Rule for later phases: when the spec is silent, a new question gets appended here, never guessed.

---

## A. Scope & fidelity (these decide what "acceptance" means)

**Q-A1. Fidelity target: faithful port, or port and fix?**
The inventory found 20 defects (inventory §13, D1–D20). Some are clearly unfinished features (D1 empty projects-info page, D2 dashboard not per-user); others are plain bugs (D3, D6).
- (a) Bug-for-bug parity: reproduce the as-is behaviour and log every defect as "known, preserved".
- (b) Fix obvious bugs (D3, D5, D6, D11, D13, D14, D20) but don't finish unfinished features.
- (c) Fix the bugs and also finish the TODO features (D1, D2, D4, D12).
*Recommended: (b).* Every fix becomes a documented, intentional deviation, which is good portfolio material and keeps scope bounded.
**Answer:**
b

**Q-A2. Dead code: port it or drop it?** (D16: `modal`, `exceptionHandler`, `crudEditMethods`, `/authenticated-user`, `/admin-user`, unused resource queries, `pushSticky`, `getCssClasses`.)
*Recommended: drop it and list each item in the spec as "not ported (dead)". One exception: give the React app a real global error boundary, since `exceptionHandler` was clearly intended.*
**Answer:**
follow recommendation

**Q-A3. Security defects D7, D8, D18 (public password reads, password pre-fill, committed secrets).** The stub will be public.
- (a) Stub mirrors the original exactly (public reads, plaintext passwords).
- (b) Stub never returns `password` in responses, and the user form no longer pre-fills it (password is required only on create; blank on edit means unchanged).
*Recommended: (b)*, plus deleting the committed MongoLab key and TLS key from the converted tree. Do you also want a note in the README that they still exist in upstream history? (The key is long dead, but a public portfolio repo shows it.)
**Answer:**
follow recommendation

**Q-A4. Are the 133 existing unit tests a parity oracle?** Should each converted unit carry over the behavioural cases from its AngularJS spec (rewritten in the new test framework), or should tests be written fresh against the spec's acceptance criteria?
*Recommended: port the behavioural cases (the "it" descriptions become the checklist) and add new tests for the untested screens (inventory §11). This gives a measurable "N of 133 cases carried over" metric.*
**Answer:**
follow recommendation

**Q-A5. Should the original AngularJS app stay runnable in the repo** (for side-by-side comparison, screenshots, or an e2e parity run against both)? That would mean reviving Grunt/Karma on an old Node via Docker or Volta.
*Recommended: no. Freeze it as reference source in `legacy/` and don't revive the toolchain. Capture "before" screenshots only if the cost is low.*
**Answer:**
follow recommendation

## B. Target stack (challenges to the proposed React 18 + Vite + React Router + TypeScript)

**Q-B1. React 18 or React 19?** Today is 2026-11. React 19 has been stable since Dec 2024, and a 2026 portfolio piece that targets 18 will read as dated. Nothing in the inventory needs 18. React 19's form actions (`useActionState`) also map well onto the crudEdit save/revert/error pattern.
*Recommended: React 19*, unless you need to demonstrate 18 for a specific employer or codebase.
**Answer:**
follow recommendation

**Q-B2. Router data model.** The original relies on route *resolves*: nothing renders until data and auth guards settle (inventory §3), and a failure produces a route-error notification. React Router's data router (`loader` / `errorElement`, v6.4+/v7) is an almost 1:1 match. The alternative is component-level fetching (`useEffect` or TanStack Query), which changes UX semantics (loading states appear where none existed).
*Recommended: React Router v7 in data/library mode (`createBrowserRouter` + loaders/actions), no framework mode/SSR.* It is the boring, faithful mapping and needs no extra data library.
**Answer:**
follow recommendation

**Q-B3. Server-state library?** With loaders handling fetching, TanStack Query would be extra.
*Recommended: none. Use loaders + a small typed `api` module.* Revisit only if a screen needs cache invalidation that loaders can't express.
**Answer:**
follow recommendation

**Q-B4. Styling.** The templates are entirely Bootstrap **2.1.1** classes (inventory §12).
- (a) Keep the Bootstrap 2 CSS as-is for pixel parity (it's vendored LESS; compile once to CSS).
- (b) Bootstrap 5 + react-bootstrap, restyling everything.
- (c) Plain CSS/CSS modules or Tailwind.
*Recommended: (a) for the conversion, so visual parity is a cheap acceptance check and the migration story stays "behaviour, not redesign". Optionally list a Bootstrap 5 restyle as a post-migration phase.*
**Answer:**
follow recommendation

**Q-B5. Test stack.** *Recommended: Vitest + React Testing Library + MSW (MSW handlers double as the API stub in tests). Add Playwright for a small e2e smoke suite (login → create project → backlog → sprint → task) running against the stub in CI.* Is Playwright e2e in scope as a blocking gate?
**Answer:**
follow recommendation

**Q-B6. Forms & validation.** crudEdit needs: deep-diff dirty tracking against an original, revert, per-field errors, and async validation (uniqueEmail).
- (a) A small hand-written `useCrudForm` hook (closest to the original; the directive is about 100 lines).
- (b) react-hook-form.
*Recommended: (a)*, because it's boring, readable, mirrors the source, and is easy to review against the spec.
**Answer:**
follow recommendation

**Q-B7. Package manager & Node version.** *Recommended: pnpm, Node 22 LTS (or 24 LTS if you prefer the newest).* Any preference?
**Answer:**
follow recommendation, 24 LTS

## C. Backend / API stub

**Q-C1. What is the stub?**
- (a) MSW in the browser only (no server; demo works on static hosting).
- (b) A small Node server (Express/Hono) with an in-memory or JSON-file store, implementing the documented surface (inventory §9).
- (c) Both: one shared handler module, exposed through MSW for tests and the static demo, and through a Node server for dev/e2e.
*Recommended: (c) if a hosted live demo matters for the portfolio, otherwise (b).* Do you want a hosted demo (e.g. GitHub Pages / Cloudflare Pages)?
**Answer:**
follow recommendation

**Q-C2. Preserve the wire quirks?** Specifically: the `)]}',\n` JSON prefix, XSRF cookie/header, `_id: {$oid}` ids, `?q=<JSON>` Mongo-style queries, the `" null "` not-found body, 200 + `user:null` on bad login, and 401 (not 403) for non-admin.
- (a) Preserve all of them, so the stub is a faithful contract double of the original server and the React client proves it can talk to the "real" backend.
- (b) Modernise: plain `id` strings, REST query params, 404/403, no prefix.
*Recommended: (a) for the contract, with the client isolating every quirk inside one `api/` adapter module.* That shows the migration technique (anti-corruption layer) and keeps the option of a later backend swap. I'd still recommend replacing `" null "` with a 404, since that was a MongoLab quirk and not part of the app's server.
**Answer:**
follow recommendation

**Q-C3. Supported query operators.** Live code uses only `{}`, `{field: value}` equality, and `{_id: {$in: [{$oid}]}}` (inventory §9.3). OK to have the stub support exactly those and reject anything else with 400?
*Recommended: yes.*
**Answer:**
follow recommendation

**Q-C4. Seed data.** The original seeds only the admin user. A demo needs fixtures. OK if I generate a small deterministic seed (about 4 users with distinct PO/SM/dev roles, 2 projects, about 8 backlog items, 2 sprints, about 10 tasks)?
**Answer:**
follow recommendation, generate the data we need to demonstrate fully

**Q-C5. Should the original `server/` directory be kept, deleted, or moved to `legacy/`?** It cannot run (MongoLab is gone).
*Recommended: move to `legacy/server` as reference.*
**Answer:**
follow recommendation

## D. Behaviour decisions the spec needs

**Q-D1. Login-modal-on-401 retry queue.** The original transparently replays failed requests after an in-place login (inventory §6.2). Keep that behaviour (a modal plus a retry of the pending navigation or action), or simplify to redirecting to a `/login` route with `?returnTo=`?
*Recommended: keep the modal + retry for parity; it's the most interesting architectural piece of the original. Implement it as an auth context plus a promise queue in the api module.*
**Answer:**
follow recommendation

**Q-D2. Client-side guards.** Backlog/sprint/task routes have no client guard (they rely on server 401 on write, while reads are public). Keep that, or guard the whole `/projects/**` tree (and `/dashboard`, D4) for authenticated users?
*Recommended: guard `/projects/**` and `/dashboard`.*
**Answer:**
follow recommendation

**Q-D3. Breadcrumbs show raw ids** (`/ projects / 5f3a… / sprints`). Keep, or resolve names?
*Recommended: keep (parity; cheap); log it as a possible enhancement.*
**Answer:**
follow recommendation

**Q-D4. i18n.** There is only one locale, with 12 keys. Keep the `localizedMessages` key/interpolation layer as a tiny module, or inline the strings?
*Recommended: keep the tiny module (parity, trivial).*
**Answer:**
follow recommendation

**Q-D5. Sprint dates** (D12) are free text. Keep free text, or use `<input type="date">` and store ISO strings?
*Recommended: depends on Q-A1. Under (b), keep free text.*
**Answer:**
follow recommendation

**Q-D6. URLs.** Keep identical paths (`/admin/users/:id`, `/projects/:projectId/sprints/:sprintId/tasks/new`, …) and HTML5 history mode?
*Recommended: yes, identical.*
**Answer:**
follow recommendation

## E. Process, workflow & repo

**Q-E1. Repo layout.** The local working directory was empty; I cloned your fork into it (remotes: `origin` = your fork, `upstream` = angular-app). Is this the intended home? Should the React app live in a new top-level `web/`, with the AngularJS code moved to `legacy/client`, on a long-lived `migration` branch?
**Answer:**
follow recommendation. 

**Q-E2. Branching / merge policy for Phase 3.** *Recommended: one worktree + branch per cluster (`convert/<cluster>`), PRs into `main`, with CI required. Who merges: you, or the reviewer agent after green CI plus a spec-diff with no unresolved "blocking" deviations?*
**Answer:**
follow recommendation. i think the reviewer agent should be good.

**Q-E3. Cluster boundaries.** Based on the seams in inventory §14, a candidate split is: (0) foundation (api adapter, auth/retry queue, notifications, crud form hook, shell), done *serially* before any parallel work; then in parallel: (1) admin-users, (2) admin-projects, (3) projects + productbacklog, (4) sprints + tasks, (5) dashboard + projectsinfo. Is it OK that cluster 4 depends on 3's types only (not its components)? Is the number of workers fixed on your side (how many worktrees will you run at once)?
**Answer:**
follow recommendation. i don't have an opinion

**Q-E4. CI host.** GitHub Actions on your fork? Should CI be required on PRs via branch protection (that needs repo-admin settings, which you'd do or authorise)?
**Answer:**
follow recommendation

**Q-E5. Metrics you want captured for the case study.** Proposed: wall-clock per phase/cluster, number of agent sessions, number of CI runs and failures before green, deviations found (by reviewer vs CI vs you), tests carried over (N/133) plus new tests, LOC before/after, bundle size before/after, and human interventions. Token/cost numbers too, if you can export them from your sessions. Anything to add or remove?
**Answer:**
follow recommendation

**Q-E6. License/attribution.** The original is MIT by Pawel Kozlowski & Peter Bacon Darwin. I'll keep LICENSE and credit them in the README. Any other attribution requirements (e.g., the Packt book link)?
**Answer:**
follow recommendation

## F. The LinkedIn article (added mid-Phase 0)

**Q-F1. Format.** One article at the end, or a short series (e.g. one post per phase: "Discovery found 20 bugs in a 'reference' app", "Spec as contract", "Parallel agents in worktrees", "What the agents got wrong")? A series fits LinkedIn's format better and makes the deviations log the finale.
**Answer:**
One article at the end.

**Q-F2. Voice & audience.** First person as you, aimed at engineering managers/CTOs (outcomes, process, risk) or at hands-on engineers (techniques, code)? Rough length target (LinkedIn articles of about 800–1,500 words do well)?
**Answer:**
aimed at managers

**Q-F3. Disclosure & claims.** Do you want to state plainly that Claude Code agents did the conversion under your direction (I'd recommend it, since that is the point of the artifact), and should metrics stay strictly measured (no estimates)? I'll keep the journal factual either way.
**Answer:**
yes

**Q-F4. Where do drafts live?** Default: `docs/article/` in the repo (markdown, plus the journal at `spec/journal.md`). Alternatively I can produce a shareable doc you can comment on.
**Answer:**
follow recommendation
