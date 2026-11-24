# Phase 5 Spec: from a fake server to production (Node + PostgreSQL, containers, AWS, DevSecOps)

Status: **APPROVED rev 1** (owner: "approve all" for §9 Q-p5-1..12, 2026-11-23). Workers start only when their wave opens (§4). Wave C also needs the owner prerequisites in §11.
Revision history: rev 0 (draft, PR #37). Rev 1 records the owner's answers (§9) and adds AC-AWS-06 (a cost alarm, because Q-p5-4 (a) runs up a monthly bill), §11 (owner prerequisites) and §12 (evidence for the article).
Inputs: `spec/conversion-spec.md` (rev 3, the contract this phase must not break), especially §7 (stub), §10 (metrics) and §12.6 (AC-STUB-*).
Authority and roles: the same as `conversion-spec.md` (owner, orchestrator, worker, reviewer). Where this spec is silent, `conversion-spec.md` applies; where both are silent, ask (§8).

---

## 0. Why this phase exists
Phases 0–4 migrated the front end against an in-memory stub that copies the legacy wire contract (`conversion-spec.md` §7). Everything was green on a fake server. This phase replaces the fake with a real one and ships it:

- a Node API on PostgreSQL that serves the **same wire contract** byte for byte;
- containers;
- an AWS deployment owned by this repo's pipeline;
- security checks as gates.

The existing 406 unit tests, 37 Playwright tests and the stub contract tests for AC-STUB-01..15 are the referee: the front end must not notice that the server changed.

## 1. Goals and non-goals
**Goals**
- G1. The same contract, two stores. AC-STUB-01..15 pass against the in-memory store **and** against PostgreSQL, from one test suite.
- G2. A relational schema, not a document dump (§3.2), with migrations and a deterministic seed.
- G3. Security fixes that a real server needs and the stub could skip (§3.4): hashed passwords, safe cookies, no reset route in production.
- G4. Containers for the API and a production web build; `docker compose up` runs the whole stack locally.
- G5. A deployment to AWS from CI, without long-lived AWS keys, that the owner can tear down with one command.
- G6. DevSecOps gates: dependency, secret, code and image scanning, all as required checks.
- G7. Honest logs as before: deviations, worklogs, journal, measured metrics.

**Non-goals**
- N1. No change to the wire contract or to anything under `web/src` except configuration (base URL), unless a question is answered first. The quirks (`)]}',` prefix, XSRF, MongoLab-shaped URLs) stay, because the front end depends on them.
- N2. No microservices for their own sake. One API service and one static front end. A split would need a reason this app does not have; §3.5 says why.
- N3. The MSW stub stays for unit tests, `pnpm dev:msw` and the GitHub Pages demo. It is not deleted.
- N4. No new product features.

## 2. Target stack (additions)
| Area | Choice | Notes |
|---|---|---|
| API runtime | Node 24, `node:http`, the existing `handle()` | No web framework: the stub's adapter already is one (§3.1) |
| Database | PostgreSQL (version per Q-p5-2) | Driver per Q-p5-3 |
| Migrations | Plain numbered `.sql` files plus a small runner | No ORM (boring on purpose) |
| Containers | Docker, multi-stage builds, non-root user | `compose.yaml` for local |
| Cloud | AWS, per Q-p5-4 | Infrastructure as code per Q-p5-5 |
| CI/CD | GitHub Actions, with OIDC to AWS | Per Q-p5-6 |
| Security gates | Per Q-p5-7 | GitHub-native tools first (free for public repos) |

## 3. Design
### 3.1 One handler, pluggable store
- `handle()` becomes `async` and takes a `Store` **interface** instead of the in-memory object. Two implementations: `MemoryStore` (today's code) and `PgStore`.
- `Sessions` gets the same treatment: `MemorySessions` and `PgSessions` (a `sessions` table), so sessions survive a restart and work with more than one container.
- The adapters (`msw.ts`, `server.ts`) only change to `await handle()`.
- The contract tests (`stub/handlers.test.ts`, `adapters.test.ts`) are parameterised over the store: `describe.each([memory, postgres])`. Postgres runs need a database (Q-p5-8); without one, the Postgres runs fail loudly, they do **not** skip (gate rule).
- Where the code lives (`web/stub/` vs a new top-level `api/`): Q-p5-1.

### 3.2 Schema (relational, translated to the wire shape)
- Tables: `users`, `projects`, `project_team_members` (join table), `backlog_items`, `sprints`, `sprint_backlog_items` (join), `tasks`, `sessions`, `schema_migrations`.
- Ids stay 24-hex strings (`char(24)`), so wire ids do not change. New ids use the same deterministic counter scheme after a reset (AC-STUB-15).
- A translation layer maps rows to wire documents (`_id: {$oid}`, field names as in `conversion-spec.md` §5.5) and back. It must keep the legacy edge cases the seed relies on:
  - a project with `teamMembers` **absent** (D13), not an empty list;
  - a sprint that references a deleted backlog item (D13). This means **no foreign key** on `sprint_backlog_items.backlog_item_id`. The reason goes in a comment and in the deviations log.
- The `q` grammar (C3: `{}`, equality AND, `$in` of `$oid`) is translated to parameterised SQL only. Never string-built SQL.
- Fields the front end sends but the schema does not know: Q-p5-9.

### 3.3 Seed and reset
- The seed (`conversion-spec.md` §7.6) is loaded from the same `seed.ts`, so both stores start identical.
- `/__stub/reset` exists only when `ALLOW_RESET=1`, which local runs and CI set and production never does. A test asserts that the production image answers 404 to it.

### 3.4 Security changes a real server needs
Each one is a deliberate difference from the stub, so each gets a D-id-style comment and a deviations row.
- S-p5-1. Passwords are hashed with `node:crypto` scrypt (no new dependency) and a per-user salt. The wire contract never carried passwords out (D7), so the front end does not notice.
- S-p5-2. Cookies: `sid` gets `HttpOnly; Secure; SameSite=Lax` in production. `XSRF-TOKEN` stays readable by script, because the front end must read it (legacy XSRF scheme), and gets `Secure; SameSite=Lax`.
- S-p5-3. Login throttling: Q-p5-10.
- S-p5-4. Secrets (database password, session secret) come from the cloud secret store, never from the image or the repo.
- S-p5-5. Security headers on the web build (CSP, `X-Content-Type-Options`, `Referrer-Policy`). The CSP must allow the app's own assets only; test it in Playwright.

### 3.5 Why not microservices
- The API has one job (five collections behind one contract) and one team.
- Splitting it would add network calls, versioning and failure modes without a benefit this app can show.
- The honest architecture is two deployable units: a static web build and one containerised API.
- Saying no to a split, with a reason, is the decision this phase documents.

### 3.6 Deployment shape (pending Q-p5-4)
- Recommended: the web build on S3 behind CloudFront, the API on ECS Fargate behind a load balancer, PostgreSQL on RDS, secrets in Secrets Manager, logs in CloudWatch.
- One environment, `demo`, created and destroyed by the pipeline. No production users.
- The same origin for web and API (CloudFront routes `/login`, `/logout`, `/current-user` and `/databases/*` to the API). The cookie scheme then works unchanged.

## 4. Clusters and ownership (parallel where independent)
| Cluster | Owns | Depends on |
|---|---|---|
| p5-store | `Store`/`Sessions` interfaces, `PgStore`, `PgSessions`, schema, migrations, contract tests over both stores | none |
| p5-security | §3.4: hashing, cookie flags, throttling, headers | p5-store (interfaces) |
| p5-containers | Dockerfiles, `compose.yaml`, e2e against the compose stack | p5-store |
| p5-infra | infrastructure as code, deploy and destroy workflows, OIDC role | p5-containers |
| p5-devsecops | scanning workflows and required checks (§6) | none; can run first |

Waves: **A** = p5-store and p5-devsecops in parallel. **B** = p5-security and p5-containers. **C** = p5-infra. Each wave opens only when the previous one is merged (the `conversion-spec.md` §8 gate rule). The worker → reviewer → PR workflow is unchanged (§8.2 there).

## 5. Acceptance criteria
### 5.1 Store (p5-store)
- AC-PG-01. AC-STUB-01..15 pass against `PgStore`, run by the same test code as `MemoryStore`.
- AC-PG-02. Migrations run from empty to current, and running them twice is a no-op.
- AC-PG-03. After a reset, the Postgres seed produces the same wire documents as the memory seed (deep-equal over all five collections).
- AC-PG-04. Project "Legacy Cleanup" comes back with `teamMembers` absent; the dangling sprint backlog reference survives a round trip (D13).
- AC-PG-05. A `q` value with SQL in it (e.g. `{"name":"x' OR '1'='1"}`) returns `[]`, not every row.
- AC-PG-06. Sessions survive an API restart.

### 5.2 Security (p5-security)
- AC-SEC-01. No stored password equals its plain text; login still works for every seed user.
- AC-SEC-02. In production mode, `sid` carries `HttpOnly`, `Secure` and `SameSite`.
- AC-SEC-03. The production build answers 404 to `POST /__stub/reset`.
- AC-SEC-04. Login throttling, per Q-p5-10.
- AC-SEC-05. The deployed page sends the §3.4 headers, and Playwright finds no CSP violations on any screen.

### 5.3 Containers (p5-containers)
- AC-CTR-01. `docker compose up` brings up the database, the API and the web build; the full Playwright suite passes against it.
- AC-CTR-02. Images run as a non-root user and contain no dev dependencies, test files or `.env` files.
- AC-CTR-03. The API container has a health check that fails when the database is unreachable.

### 5.4 Infrastructure and deploy (p5-infra)
- AC-AWS-01. A merge to `migration` deploys `demo` only after all required checks pass.
- AC-AWS-02. CI authenticates to AWS through OIDC; the repo holds no AWS access keys (checked by the secret scan).
- AC-AWS-03. After a deploy, a smoke test signs in as a seed user over HTTPS and loads the projects list.
- AC-AWS-04. One documented command destroys the environment, and a second run of it is a no-op.
- AC-AWS-05. The database is not reachable from the internet.
- AC-AWS-06. An AWS budget alarm e-mails the owner before the monthly cost of `demo` passes a limit the owner sets. The limit is not written in the repo.

### 5.5 DevSecOps (p5-devsecops)
- AC-DSO-01. Each scan in §6 is a required check on `migration`, and a deliberately planted finding of each kind turns it red (the reviewer's breakages, logged).
- AC-DSO-02. Dependency updates arrive as PRs and go through the same gates.

## 6. Gates added
The current five checks stay. Added, per Q-p5-7:
- **integration:** the contract tests against PostgreSQL;
- **e2e-compose:** Playwright against the compose stack;
- **codeql:** static analysis;
- **deps:** dependency audit;
- **secrets:** GitHub secret scanning with push protection;
- **image-scan:** the built images, high and critical findings fail.

`pnpm verify` gains the integration run.

## 7. Metrics and logs
- Unchanged from `conversion-spec.md` §10, plus:
  - CI time per new gate;
  - image sizes;
  - deploy time;
  - the measured monthly cost of `demo` from AWS billing (not estimated).
- Every deliberate difference from the stub (§3.2's missing foreign key, §3.4) is a row in `spec/deviations.md` with id `DEV-p5-<n>`.
- The journal gets an entry per wave, written for the same audience as before.

## 8. Questions during Phase 5
As in `conversion-spec.md` §8.5: `spec/questions/<cluster>.md`, id `Q-<cluster>-<n>`.

## 9. Owner decisions (answered 2026-11-23: "approve all")
Every recommendation below is accepted. Where a recommendation offered two options, the first one applies: Q-p5-4 is **(a)** (S3 + CloudFront, ECS Fargate, RDS), so Q-p5-7 uses ECR scan-on-push. The owner may still switch Q-p5-4 to (b) before wave C opens if the measured cost is too high.

| Id | Question | Options | Recommendation |
|---|---|---|---|
| Q-p5-1 | Where does the API live? | (a) keep it in `web/stub/`, (b) new top-level `api/` package that imports the shared contract | **(b)**: a real service deserves its own package, Dockerfile and owner; the MSW stub keeps importing the same `handle()` |
| Q-p5-2 | PostgreSQL version | the current major vs the previous one | The newest major that RDS supports as of approval |
| Q-p5-3 | Driver | (a) `pg`, (b) `postgres` (porsager) | **(a) `pg`**: the most widely used and understood; one new dependency |
| Q-p5-4 | AWS shape | (a) S3 + CloudFront web, ECS Fargate API, RDS; (b) one small EC2 or Lightsail instance running compose; (c) not AWS yet, compose only | **(a)** if a running monthly cost is acceptable; **(b)** if cost matters more than showing managed services. Cost is the owner's call and will be measured, not guessed |
| Q-p5-5 | Infrastructure as code | (a) AWS CDK (TypeScript), (b) Terraform, (c) CloudFormation YAML | **(a) CDK**: same language as the repo, type-checked by the existing gate |
| Q-p5-6 | Deploy pipeline | (a) GitHub Actions with OIDC, (b) AWS CodePipeline triggered by the repo | **(a)**, because the gates already live in Actions. (b) is a fair choice if showing CodePipeline matters |
| Q-p5-7 | Scanners | CodeQL, Dependabot + `pnpm audit`, GitHub secret scanning, Trivy or ECR scan-on-push for images | **All of them, with ECR scan-on-push** (no extra tool). If not deploying (Q-p5-4 c), Trivy in CI |
| Q-p5-8 | Database for tests | (a) a Postgres service container in CI and compose locally, (b) Testcontainers | **(a)**: no new dependency, and the same thing runs locally and in CI |
| Q-p5-9 | Unknown fields in a write | (a) reject with 400, (b) drop silently, (c) keep them in a `jsonb` `extra` column | **(c)**: legacy (MongoLab) stored whatever was sent, so (a) or (b) could change behaviour the front end relies on |
| Q-p5-10 | Login throttling | (a) none (as legacy), (b) per-IP and per-account limit with a `429` | **(b)**, as a logged deviation. It changes the contract for abusive clients only. A test must show that the login modal shows serverError on a 429 |
| Q-p5-11 | Is `demo` public? | (a) public, with the README's seed credentials, reseeded nightly; (b) public but read-only for anonymous; (c) private (owner's IP or a login in front) | **(a) with a nightly reseed**: a recruiter can click it. Anyone can edit the demo data, which is why it's reseeded. Never store anything real in it |
| Q-p5-12 | Mutation testing (the gap logged in #34) | (a) add Stryker as a scheduled job, (b) later | **(b)**: keep this phase about the server; open it as its own question |

## 10. Exit criteria
- Every AC in §5 has a test named with its id, and it passes.
- `pnpm verify` and every check in §6 are green on `migration`.
- `demo` deployed from CI, smoke test green, destroy command proven once.
- `spec/deviations.md` has the `DEV-p5-*` rows, and the README gains a Phase 5 section with measured numbers.

## 11. Owner prerequisites (before wave C)
- An AWS account the owner controls, with billing access.
- The owner runs the one-time bootstrap: CDK bootstrap and the GitHub OIDC role. Agents never hold AWS console credentials or long-lived keys. They get the deploy role only through CI.
- The owner sets the budget alarm limit (AC-AWS-06).
- Account ids, the role ARN and the alarm e-mail stay out of the repo: GitHub repository variables and secrets only.

## 12. Evidence for the article
The Phase 5 article and post are written from the record, like the first one. Each wave must leave the evidence the readers' questions will need (the list is in `spec/journal.md`, entry "Phase 5 begins"):
- the stub contract tests that failed against Postgres before they passed, with the reason, from `spec/metrics.jsonl` and the worklogs;
- breakages chosen by the owner for every wave, not only by agents, with the results;
- each scanner's planted finding and its red run (AC-DSO-01);
- the deploy role's permissions as written, and who ran which deploy;
- the measured AWS cost, from the bill;
- every human intervention (answers, overrides, vetoes).

