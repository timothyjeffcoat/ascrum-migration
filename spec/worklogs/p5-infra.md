# Worklog: cluster p5-infra (Phase 5, wave C)

## 2026-11-24, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`; §4 has the p5-infra row with its
owned paths (added 2026-11-24, owner); `MIGRATION.md` shows wave C **open** (PR #67, `f42e176`). Branch
`convert/p5-infra` from `origin/migration` (`f42e176`) in its own worktree; `origin/migration` gained
`b42c1ee` (#68, journal only) during the session and was merged in before the PR (no rebase of anything
pushed). Ports: e2e 4101/5273/5274; PostgreSQL for the integration run in a throwaway container on 55461.

**No AWS credentials were used.** I never ran `aws`, `cdk deploy`, `cdk destroy` or `cdk bootstrap`, and
every `cdk synth` and test run had `AWS_PROFILE` unset and `AWS_SHARED_CREDENTIALS_FILE=/dev/null
AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true` (a wrapper script in my scratch directory).
Read-only `gh api` calls on the public repository were used to design the deploy gate (branch protection
and check runs of `f42e176` and PR #67's head).

### What was built

- **`infra/`**, a CDK app (Q-p5-5) with its own `package.json` and lockfile, added to
  `pnpm-workspace.yaml`. New dependencies are only the ones Q-p5-5 covers: `aws-cdk-lib` 2.275.0,
  `constructs` 10.8.1, `aws-cdk` 2.1148.0 (pinned exactly; I chose the newest releases at least two weeks
  old, as supply-chain caution; Dependabot moves them). Its dev tools (`typescript`, `vitest`, `eslint`,
  `prettier`, `@playwright/test`, `@types/node`) are `link:` entries into `web/node_modules`, the same
  pattern `api/` uses for `vitest`, so no second copy and no new version. `pnpm audit` in `infra/`: "No
  known vulnerabilities found".
  - `src/bootstrapStack.ts` (`AscrumBootstrap`, deployed once by the owner with
    `CliCredentialsStackSynthesizer`, termination-protected, never touched by the workflows): GitHub OIDC
    provider (L1 `CfnOIDCProvider`, no Lambda; or an existing provider's ARN), the deploy role, the
    CloudFormation execution policy for `cdk bootstrap --cloudformation-execution-policies`, the
    permissions boundary for the demo's roles, and the budget alarm (AC-AWS-06; limit and e-mail are
    CloudFormation parameters without defaults, the e-mail `NoEcho`).
  - `src/registryStack.ts` (`AscrumDemoRegistry`): ECR repository, scan on push, immutable tags,
    CloudFormation's own `EmptyOnDelete`.
  - `src/demoStack.ts` (`AscrumDemo`): VPC with public and isolated subnets and no NAT; RDS PostgreSQL 18
    in the isolated subnets, not public, password managed by RDS; ECS Fargate API (the image the run
    pushed) in a public subnet, admitting only the ALB; ALB admitting only CloudFront's origin-facing
    prefix list, forwarding only with a per-run secret header; private S3 bucket behind CloudFront (OAC);
    CloudFront routes the contract paths (and `/__stub/*`, so the production API answers 404) to the ALB,
    the rest to S3 with a CloudFront Function as the SPA fallback; response headers generated from
    `web/securityHeaders.ts` plus HSTS (`src/securityHeadersPolicy.ts`).
  - `src/app.ts`: tags (`project=ascrum-migration`, `ascrum-env=demo|bootstrap`), synthesizers (qualifier
    `ascrum`), the boundary on every demo role, and the deploy-time context (`demoDeploy=true` makes
    `imageTag`, `originSecret` and `cloudFrontPrefixListId` required; without it, placeholders, so CI can
    synth with nothing).
  - `scripts/requiredChecks.ts` (AC-AWS-01 gate), `scripts/destroy.ts` (AC-AWS-04: deletes the demo
    stacks with CloudFormation directly, from any state, emptying the web bucket first; idempotent),
    `scripts/leftovers.ts` (AC-AWS-04 final check), `scripts/aws.ts` (the CLI as an injectable function),
    `scripts/fakeAws.ts` (the tests' stand-in).
  - `smoke/` (AC-AWS-03, Playwright, run only by the deploy workflow): HTTPS and the HTTP redirect; sign
    in as `dev1` and load the projects list (3 rows, as AC-PRJ-01) with a screenshot; the cookies' flags
    (AC-SEC-02 on the deployment); the headers (AC-SEC-05 on the deployment); `POST /__stub/reset` → 404
    (AC-SEC-03 on the deployment); the ALB refusing direct traffic.
  - `README.md`: the owner's one-time steps (bootstrap stack with the budget parameters, `cdk bootstrap`
    with qualifier, tags and execution policy, the OIDC subject customisation, the `aws-demo` environment
    with its branch rule, variable `AWS_REGION` and secret `AWS_DEPLOY_ROLE_ARN`), the permissions table,
    the design notes. No account id, ARN, e-mail or limit anywhere.
- **`.github/workflows/deploy-demo.yml`** (manual only): `gate` (on `migration`, every required check
  passed on the head commit) → `deploy` in environment `aws-demo` (OIDC; registry stack; API image built
  from the commit and pushed; ECR scan result, any HIGH/CRITICAL stops the run; demo stack; web build to
  S3; wait for HTTPS; smoke test; on failure the API logs and failed stack events; account ids redacted;
  artifact) → `destroy` (`if: always() && needs.gate.result == 'success'`, so also after a failure or a
  cancel; its own job with its own timeout; destroy, then the leftover check) → `evidence` (download both
  artifacts, add every step's timing from the run's jobs API, one artifact `demo-evidence-<run>-<attempt>`
  kept 90 days). One concurrency group `aws-demo` for both workflows, never cancelled in progress.
- **`.github/workflows/destroy-demo.yml`** (manual only): the same destroy and leftover steps on their own.
- **CI:** a new `infra` job in `ci.yml` (lint, typecheck, unit tests, `cdk synth` with every credential
  source pointed at `/dev/null`). `deps.yml` needed nothing: its lockfile discovery already audits
  `infra/pnpm-lock.yaml` (checked by reading its importer logic against the new lockfile). Dependabot: an
  `/infra` npm entry, the three CDK packages grouped.

### Decisions (and why)

- **The deploy role trusts a customised OIDC subject** naming the environment and the workflow file on
  `migration` (Q-p5-infra-1 (a)). Agents push branches to this repository; with the default subject only
  a GitHub-side environment rule would keep a workflow on such a branch from assuming the role.
- **CDK bootstrap with qualifier `ascrum` and a written execution policy**, not CDK's default
  AdministratorAccess: otherwise "least privilege" would stop at `sts:AssumeRole` on CDK's deploy role. The
  policy lists write actions by name, limits most to the region, lets CloudFormation create roles only
  named `AscrumDemo*` and only with the boundary, and denies removing a boundary. The bootstrap stack
  itself is deployed before `cdk bootstrap` (no assets, CLI credentials; a test keeps its template under
  the 51,200-byte inline limit), which breaks the chicken-and-egg of the policy ARN.
- **Own ECR repository in its own stack, image pushed by the workflow**, not a CDK `DockerImageAsset`: the
  scan result can gate the run before the service exists, the repository (and its images) are deleted
  with the run, and synth never stages the repo root as an asset.
- **No Lambda-backed custom resources at all** (no `autoDeleteObjects`, no `restrictDefaultSecurityGroup`,
  L1 OIDC provider, ECR's native `EmptyOnDelete`, RDS-managed secret instead of a CDK secret): fewer
  things a destroy depends on, and no Lambda permissions in the execution policy. The cost: the destroy
  script empties the web bucket itself, and the default security group keeps its default rules (nothing
  uses it).
- **No NAT gateway** (always billed per hour): the API task gets a public address; its security group
  admits only the ALB, and its egress is 443 anywhere plus 5432 to the database.
- **RDS manages the password** (`manageMasterUserPassword`): no password in the template or the repo, and
  the execution policy needs no permission to read secret values. The container builds `DATABASE_URL` at
  start from the secret's fields, percent-encoded (a test runs the script with a password full of URL
  syntax), then `exec node api/src/main.ts`. `sslmode=no-verify` (Q-p5-infra-3).
- **Destroy without synth**: `aws cloudformation delete-stack`, which uses the stack's own execution role,
  so the destroy job needs no context, no install and no CDK; it waits out a create or rollback in
  progress and cancels an update in progress.
- **Leftover check asks the services** about types the tagging index keeps after deletion (deregistered
  task definitions, inactive clusters, secrets pending deletion), and retries the rest for the index's
  lag. It lists the region and us-east-1 (CloudFront).
- **Required checks are read from branch protection**, not copied into the workflow; `CodeQL` (PR-only)
  is taken from the merged PR's head (Q-p5-infra-5).
- **Evidence never holds the account id**: `mask-aws-account-id: true`, the role ARN is an environment
  secret, the scan evidence drops `registryId`, and every text file in the evidence is redacted
  (12-digit numbers) before upload; the scripts redact too (tested).

### Wrong turns and mistakes

- My first version of the demo stack test used a random-looking 64-hex `originSecret` as test data.
  Running the repo's pinned Gitleaks (8.30.1, checksum verified, in my scratch directory) over my two
  local commits flagged it (`generic-api-key`). The commits were not pushed, so I reset them softly onto
  `origin/migration` and recommitted with a low-entropy test value (`'testoriginsecret'.repeat(4)`); the
  rescan found nothing. Had I pushed first, the `secrets` check would have gone red on the PR.
- The first two unit-test runs had three failures in my own tests, not the stacks: managed policies
  cannot carry CloudFormation tags (the tag test now skips them, and they are not in the tagging index
  either), `iam:CreateServiceLinkedRole` is an IAM "create" that my IAM-writes test had not expected (now
  asserted separately, with its service-name condition), and the boundary condition is a `Ref`, not a
  name (the test now resolves it).
- I first put the CDK qualifier in `cdk.json`; the tests build the app without the CLI, so they would not
  have seen it. It now lives in code (`CDK_QUALIFIER`), and the tests load `cdk.json`'s feature flags so
  they synthesise what the CLI does.
- An `Edit` aimed at `.github/dependabot.yml` used the main checkout's path instead of the worktree's; the
  harness refused it, and the edit went to the worktree copy.

### Breakages I tried (one at a time on the unit tests, restored after each)

19 of 19 red: trust `StringEquals` → `StringLike`; database `publiclyAccessible: true`; leftover check
keeping anything not tagged `demo`; destroy not emptying the bucket; required checks accepting `skipped`;
log group `RETAIN`; database open to `0.0.0.0/0`; `TRUST_PROXY_HOPS: '1'`; `iam:PassRole` on the deploy
role; no permissions boundary; the PR fallback accepting any PR; ALB open to `0.0.0.0/0`; COOP dropped from
the headers policy; an active task definition treated as deleted; a second destroy run deleting again;
the forecast notification turned into a second actual one; the head-of-branch check removed; 7-day
backups; the password not percent-encoded.

### AC status

| AC | Status | Where |
|---|---|---|
| AC-AWS-01 | **built, awaiting the first live run** | `deploy-demo.yml` (`workflow_dispatch` only; `gate` job); `scripts/requiredChecks.ts` + 11 tests; trust policy pinned to `migration` (`bootstrapStack.test.ts`) |
| AC-AWS-02 | **built, awaiting the first live run** (offline part proven) | OIDC only (`configure-aws-credentials` with `role-to-assume`); no IAM user/key in any stack; trust, deploy-role and execution-policy tests; the secrets scan (Gitleaks) clean on this branch |
| AC-AWS-03 | **built, awaiting the first live run** | `smoke/smoke.spec.ts` (5 tests, `--list` checked); CloudFront/ALB/SG tests in `demoStack.test.ts` |
| AC-AWS-04 | **built, awaiting the first live run** (logic proven offline) | `destroy` job (`always()`), `destroy-demo.yml`; `scripts/destroy.ts` + 10 tests (incl. second run is a no-op, partial and cancelled deploys); `scripts/leftovers.ts` + 8 tests; no retain/snapshot/protection (stack tests) |
| AC-AWS-05 | **proven on the template**; live confirmation on the first run | `demoStack.test.ts`: not public, isolated subnets with no routes, ingress only from the API's security group |
| AC-AWS-06 | **built, awaiting the owner's bootstrap deploy** | `AscrumBootstrap` budget; `bootstrapStack.test.ts` (monthly cost, 80 % actual, 100 % forecast, parameters without defaults) |
| AC-AWS-07 | **built, awaiting the first live run** | `deploy-demo.yml` artifacts (`deploy-evidence`, `destroy-evidence`, combined `demo-evidence-<run>-<attempt>` with `timings.json`/`.tsv`, `run.json`, screenshot, smoke output, image scan) |

### Questions

Q-p5-infra-1..8 in `spec/questions/p5-infra.md`, each implemented as recommended; none blocks the PR.
Before the first live run the owner needs at least -1 (the OIDC subject step) and -6 (region).

### Gate results (this session)

All run unpiped (output redirected to a file, exit code checked), Node 24.22.3, pnpm 12.21.0.

`pnpm verify` in `web/` with `STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274` and
`DATABASE_URL=postgres://ascrum:ascrum@localhost:55461/ascrum` (throwaway `postgres:18.7-alpine3.24`
container): **exit 0**.

```
$ eslint --max-warnings 0 . ../api ../docker && prettier --check . ../api ../docker
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p ../docker/tsconfig.json
$ vitest run --project unit
 Test Files  42 passed (42)
      Tests  443 passed (443)
$ vitest run --project integration
 Test Files  6 passed (6)
      Tests  87 passed (87)
$ pnpm build && pnpm build:pages && playwright test
  41 passed (24.1s)
```

`pnpm verify` in `infra/` (lint, typecheck, unit, synth) with `AWS_PROFILE` unset and
`AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true`, after
`rm -rf cdk.out`: **exit 0**.

```
$ eslint --max-warnings 0 . && prettier --check .
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
$ vitest run
 Test Files  6 passed (6)
      Tests  65 passed (65)
$ cdk synth --quiet --no-notices -c githubRepository=${GITHUB_REPOSITORY:-example-owner/ascrum-migration}
Successfully synthesized to …/infra/cdk.out
Supply a stack id (AscrumBootstrap, AscrumDemoRegistry, AscrumDemo) to display its template.
```

Also: `pnpm install --frozen-lockfile` (web/, whole workspace) "Lockfile is up to date"; `pnpm audit
--audit-level high` in `infra/` "No known vulnerabilities found"; Gitleaks 8.30.1 over
`origin/migration..HEAD` "no leaks found". Synthesised template sizes: bootstrap 27 KB, registry 7 KB,
demo 46 KB; the installed CDK packages take 207 MB in `infra/node_modules/.pnpm` (Q-p5-infra-7).

Not run, by design: the deploy and destroy workflows and the smoke test need the owner's one-time
bootstrap (spec §11). `pnpm smoke --list` (with a dummy https URL) lists its 5 tests.

### For the reviewer
- Please check the execution policy and the deploy role against what the first live run actually needs:
  I wrote them from the resource types in the templates, without a live run. A missing action fails the
  deploy (then the destroy job runs), it does not widen anything; the run's stack events (kept in the
  evidence on failure) name the action.
- AC-AWS-01..04 and -07 are proven only by the first live run after the owner's steps in
  `infra/README.md`. AC-AWS-05 and -06 are pinned on the templates.

## 2026-11-24, session 1, continued (worker): two CI failures on PR #69

I opened the PR and reported without waiting for CI (wrong turn: the Definition of Done leaves CI to the
reviewer, but "done" should not be claimed on checks I had not seen). The orchestrator relayed two
failures; both were mine.

1. **`infra` job: `sh: 1: eslint: not found` (exit 127).** Infra's dev tools are `link:` entries into
   `web/node_modules`. The job's log shows the workspace install linking `../infra` *before* `web/` was
   populated; pnpm then creates the symlinks but no `.bin` shims for those tools, so `eslint`, `tsc`,
   `vitest` and `prettier` were not on the script's PATH. Locally the shims existed (the order was
   different on a warm store), so my runs never showed it. Worse, this machine has a system ESLint 6.4.0
   in `/usr/bin`, so a missing shim here could have run the wrong ESLint silently.
   **Fix:** infra's scripts start each tool through its own entry file in the linked package
   (`node node_modules/eslint/bin/eslint.js`, `prettier/bin/prettier.cjs`, `typescript/bin/tsc`,
   `vitest/vitest.mjs`, `@playwright/test/cli.js`), which exists whatever order the install used. `cdk`
   (a real dependency, with its own shim in CI) is unchanged. No gate changed: same tools, same versions,
   same flags. Noted in `infra/README.md`.
   **Clean-state proof:** `git archive HEAD` into a fresh directory (no `node_modules`, no `cdk.out`; a
   `git clone` outside the worktree is refused by my sandbox), `pnpm install --frozen-lockfile` in `web/`
   as `setup-web` does, then the `.bin` shims of the five linked tools deleted to recreate CI's state
   (only `cdk` left), then only the job's steps with every AWS credential source at `/dev/null`:
   `pnpm lint` exit 0 ("All matched files use Prettier code style!"), `pnpm typecheck` exit 0,
   `pnpm test` exit 0 ("Test Files 6 passed (6)", "Tests 65 passed (65)"), `pnpm synth` exit 0
   ("Successfully synthesized to …/clean2/infra/cdk.out").
2. **CodeQL, 5 alerts.** `actions/unpinned-tag` (3): `aws-actions/configure-aws-credentials@v6` in both
   workflows is now pinned to the v6.3.0 commit, `@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0`
   (the comment form Dependabot updates). `js/regex/missing-regexp-anchor` and
   `js/incomplete-hostname-regexp` (`bootstrapStack.test.ts`): the `toThrow(/token.actions.githubusercontent.com/)`
   pattern (unescaped dots, no anchor) is now the exact message as a string. No alert dismissed.

## 2026-11-24, round 3 (worker): the blocked review (DEV-p5-infra-01..09)

The reviewer blocked PR #69 on DEV-p5-infra-01 and -02 and logged seven non-blocking findings plus the
owner's breakage O4 (7 of 14 variants survived). The owner's decision: fix the code now; the owner's AWS
account is a general one (a dedicated member account is being created in parallel), so the code must be
safe in a shared account. I pulled `e3abc75`, `b5e6909`, `5cfe64c`, read `spec/deviations.md` and both PR
comments. Replies per finding below; `spec/deviations.md` and `MIGRATION.md` are the reviewer's.

### DEV-p5-infra-01 (blocking): fixed, by removing CDK's bootstrap roles altogether
The finding was right, and my README table was wrong: I had checked the deploy role's own policy and
never read what `cdk-ascrum-deploy-role` may do. The fix (Q-p5-infra-9):
- **No `cdk bootstrap`.** New `infra/src/synthesizer.ts` (`InlineTemplateSynthesizer`): the stack
  manifest names no role to assume, no lookup role, no staging bucket, no bootstrap version; the demo
  stacks' manifests name the bootstrap stack's new execution role `ascrum-cfn-exec`, which the CLI
  passes as `RoleARN` (the effect of `--role-arn`, but fixed per stack, so it cannot be left off or given
  to another stack). Templates go inline; all three are far under 51,200 bytes (bootstrap 20 KB, demo
  31 KB, registry 3 KB as compact JSON), pinned by a test on the YAML the CLI sends, with 4 KiB to spare.
- **Execution role** `ascrum-cfn-exec` in `AscrumBootstrap`: trusted by `cloudformation.amazonaws.com`
  only, holding only the execution policy (tests pin trust, attachments, no inline policy).
- **Deploy role:** no `sts:AssumeRole` at all. `cloudformation:CreateChangeSet` on `stack/AscrumDemo*/*`
  only with `cloudformation:RoleArn` = the execution role; describe/execute/delete change sets, read,
  cancel and delete on `stack/AscrumDemo*/*` only; `iam:PassRole` on the execution role only, to
  `cloudformation.amazonaws.com` only. No `CreateStack`/`UpdateStack`. Explicit denies:
  `UpdateTerminationProtection`, `SetStackPolicy`, `Create/ExecuteStackRefactor` on `*`, and
  `cloudformation:*` on `AscrumBootstrap` and `CDKToolkit*`.
- **CDK's own roles:** none exist any more, so there is nothing to constrain. README step 2 now says not
  to run `cdk bootstrap`, and to delete `CDKToolkit-ascrum` if it was created from the old README.
- README "What a deploy run may do" rewritten to say what each identity reaches, including what is not
  scoped; tests pin the deploy role action by action and resource by resource.
- **Wrong turn found on the way:** the old `AscrumBootstrap` used `CliCredentialsStackSynthesizer`, whose
  manifest points the template at `cdk-hnb659fds-assets-…`; the CLI always uploads a template that has
  an asset URL, so step 1 of my README ("needs no CDK bootstrap") would have failed in an account without
  a default CDK bootstrap. The new synthesizer fixes that too. I had read the manifest, not the CLI.

### DEV-p5-infra-02 (blocking): fixed
`requiredChecks.ts` falls back to the merged PR's head only for `PR_ONLY_CHECKS` = `CodeQL` from app
57789 (name and app must both match). Named tests: the reviewer's probe (no run on the commit, all green
on the PR head: refused), a `[skip ci]`-style commit, one push check missing, a `CodeQL` from another app.
Q-p5-infra-5 corrected.

### DEV-p5-infra-05: fixed where AWS allows it; the rest listed
- Fixed names for resources whose ARNs carry a name (`src/names.ts`): load balancer `ascrum-demo`, target
  group `ascrum-demo-api`, ECS cluster `ascrum-demo`, task family `ascrum-demo-api`, DB instance and
  subnet group `ascrum-demo-db`, CloudFront function `ascrum-demo-spa-fallback`. The execution policy
  names those ARNs (listeners and rules through the load balancer's name; services through the cluster's;
  `CreateDBInstance` also on the default `og:`/`pg:` groups it uses).
- EC2 network resources (generated ids): creates are region-bound only; every change and delete needs
  `aws:ResourceTag/project = ascrum-migration` plus the region; `ec2:CreateTags` only with
  `ec2:CreateAction` in the five creates (tag on create), or on an already-tagged resource. So a foreign
  VPC can neither be changed nor be given the tag that would make it deletable.
- **Not scopable, left with the reason:** `ecs:RegisterTaskDefinition`/`DeregisterTaskDefinition`
  (region only; I did not find resource-level support I could rely on); CloudFront distributions, origin
  access controls and response headers policies (global, generated ids, no `aws:ResourceTag` support);
  `kms:CreateGrant`/`DescribeKey` (through RDS and Secrets Manager only, as before). The README names
  these and recommends the dedicated account.
- **Risk for the first live run (fails closed):** if a CloudFormation EC2 handler creates a resource
  without tags and tags it afterwards, `CreateTags` is denied and the deploy fails; the stack events will
  name it. The same applies if a security-group-rule resource is evaluated for `aws:ResourceTag`.

### DEV-p5-infra-04: fixed
`iam:TagRole`, `UntagRole`, `UpdateRoleDescription`, `ListInstanceProfilesForRole` (and the reads,
`DeleteRolePolicy`, `DeleteRole`) moved to a statement on `role/AscrumDemo*` without the boundary
condition; the boundary statement keeps `CreateRole`, `PutRolePolicy`, `AttachRolePolicy`,
`DetachRolePolicy`. `logs:FilterLogEvents`/`DescribeLogStreams` on both log-group ARN forms. The web
bucket statement has `s3:Get*` on the bucket ARN (configuration reads, not objects). Nothing else widened.

### DEV-p5-infra-06: fixed (README)
No required reviewers or wait timer on `aws-demo`, with the reason (the destroy job would wait for its
own approval). New README step 0: a dedicated AWS Organizations member account, recommended.

### DEV-p5-infra-07, -08: nothing to change in code
-07 is an owner step for the first live run, as the reviewer wrote. -08: agreed.

### DEV-p5-infra-03 and -09 (O4): test gaps closed
- `scripts/workflows.test.ts` parses both workflow files (yaml from `aws-cdk-lib`'s bundled copy,
  `src/testYaml.ts`, no new dependency): triggers, the migration step, the gate command, `needs`/`if` of
  deploy, destroy and evidence, environments and `id-token`, SHA-pinned credentials with exactly the
  role inputs, no stored key, the image-scan gate and its place, no `continue-on-error`, and `|| true`
  only in the readiness poll and the failed-run evidence step.
- `scripts/entrypoints.test.ts` runs the destroy and leftover steps' own `run:` text from both workflow
  files, in bash `-eo pipefail`, from the repository root, with a fake `aws` (`scripts/fakeAwsBin.ts`)
  on PATH: a stack that cannot be deleted, an AccessDenied, a stack still standing and a failed
  `get-resources` each fail the step; the clean cases pass.
- `stackStatus()` now treats only `(ValidationError) … Stack with id … does not exist` as absent
  (`scripts/aws.test.ts`, S22); tests for S13, S14, S19, S20, RDS and every non-ECS/Secrets service as a
  leftover, R17, R24, R25, R26, R27 (an exact allow-list), R30 (no address range of either family).

### Breakages, round 3 (one at a time, never committed; scratchpad runner, tests only)
42 breakages: the reviewer's 19 survivors from DEV-03 and the 7 O4 survivors as they described them,
plus 16 against this round's fixes. **All 42 red.**
- Workflows: W01 push trigger, W02 destroy `if: needs.deploy.result == 'success'`, O4 (a) `!cancelled()`,
  W03 migration step `if: false`, W04 gate `|| true`, W05 and O4 (d) `continue-on-error` on the leftover
  step (both files), W06 no environment, W07 scan gate disabled, W08 static keys, O4 (c) destroy `|| true`.
- Scripts: O4 (c) destroy's main exits 0 on error, O4 (d) leftovers always exit 0, O4 (d) every `rds`
  ARN a ghost, S13, S14, S19, S20, S22 (any error absent), S22b (a loose `/does not exist/`).
- Policy: R17, R24, R25, R26, R27, R30.
- This round: deploy role gets `sts:AssumeRole`; change set without the RoleArn condition; `stack/*/*`;
  termination protection no longer denied; bootstrap stack no longer denied; demo stacks back on the
  caller's credentials (no execution role in the manifest); PassRole to any service; execution role
  trusted by ECS; PR fallback for every check; PR fallback by name only; an EC2 delete without the tag;
  `CreateTags` without `ec2:CreateAction`; load balancer ARN `*`; `db:*`; the load balancer unnamed;
  `iam:TagRole` back under the boundary condition.
- **Wrong turn in the runner:** R27 and the untagged-delete breakage first "survived" because my runner's
  `grep -qF` matches a multi-line pattern line by line, so it reported a pattern as found when the
  Python replace did not apply it. Rewritten against the real text, both are red. (An unapplied breakage
  can only show as a false survivor, never as a false red.)
- **Also:** at the start of this round my worktree's index and files still held the pre-review
  `MIGRATION.md` and `spec/deviations.md` (staged as the inverse of the reviewer's commits); I restored
  both to the pulled HEAD and did not edit them.

### Gates (this session, every AWS credential source at `/dev/null`, `AWS_PROFILE` unset)
- infra `pnpm verify` (lint, typecheck, test, synth) exit 0: "All matched files use Prettier code
  style!", "Test Files 9 passed (9)", "Tests 116 passed (116)", "Successfully synthesized to …/infra/cdk.out".
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0:
  "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "41 passed" (e2e).
- No AWS command run; nothing read `~/.aws`.

### Still only provable live
AC-AWS-01..04 and -07 remain built, awaiting the first live run. New for that run: the change-set ARN
question and the EC2 tag-on-create question (Q-p5-infra-9), the CloudFormation `TagResource` on the demo
stacks (granted in case CloudFormation asks for it when the CLI passes stack tags), and the reviewer's
O4 live checks 1-4 (DEV-p5-infra-09).

## 2026-11-24, round 4 (worker): the re-review's blocking DEV-p5-infra-10
Pulled `6eb83a7` (the reviewer's deviations row -10 and MIGRATION row; not edited). The worktree again
held both reviewer files staged in reverse; restored to HEAD, not committed. Stopped my leftover
round-3 background monitors before starting.

### Wrong turn (the cause of DEV-10)
Round 3 said "CloudFront supports no `aws:ResourceTag` condition" in a code comment, in the README table
and in a test ("CloudFront is the one unscoped exception") without checking the Service Authorization
Reference. The claim was false, and the test pinned the unscoped grant as the expected state, so every
breakage that round (mine and the reviewer's O4) tested the wrong target: removing scope could not turn
anything red because there was no scope. Lesson: an "AWS does not support X" claim gets a citation
before it gets a test. Same for "ECS does not scope task definition registration" (also false for
`RegisterTaskDefinition`, below).

### Sources (Service Authorization Reference, read 2026-11-24)
- `list_amazoncloudfront.html`: `CreateDistribution` has no resource type, condition keys
  `aws:RequestTag/${TagKey}`, `aws:TagKeys`. `UpdateDistribution`, `DeleteDistribution`: resource
  `distribution*`, `aws:ResourceTag/${TagKey}`. `TagResource` (distribution): `aws:RequestTag`,
  `aws:ResourceTag`, `aws:TagKeys`. `UntagResource` (distribution): `aws:ResourceTag`, `aws:TagKeys`.
  Resource type `distribution`: `arn:${Partition}:cloudfront::${Account}:distribution/${DistributionId}`.
  Origin access control and response headers policy actions and resource types: no condition keys.
  The API operation `CreateDistributionWithTags` maps to the IAM actions `CreateDistribution`,
  `TagResource` (plus `CreateConnectionGroup`, `GetVpcOrigin`); there is no IAM action named
  `cloudfront:CreateDistributionWithTags`, so round 3's entry for it granted nothing and is removed.
- `list_awssecretsmanager.html`: `GetSecretValue`, `DescribeSecret`: resource `Secret*`, condition keys
  include `aws:ResourceTag/${TagKey}` and `secretsmanager:ResourceTag/tag-key`.
- `list_amazonelasticcontainerservice.html`: `RegisterTaskDefinition`: resource `task-definition*`
  (`arn:${Partition}:ecs:${Region}:${Account}:task-definition/${Family}:${Revision}`);
  `DeregisterTaskDefinition`: no resource type, no condition keys.
- `list_awscloudformation.html`: `CreateChangeSet` accepts `cloudformation:ImportResourceTypes`.
- **Not found in AWS documentation:** the tag key `aws:rds:primaryDBInstanceArn` on RDS-managed
  secrets. The Secrets Manager guide (`service-linked-secrets.html`, the RDS integration page, the
  search page) and the RDS guide (`rds-secrets-manager.html`) name the `rds!` prefix but no tag; only
  third-party repositories and an emulator name the key. Used as the reviewer suggested (fails closed);
  Q-p5-infra-10 records it for the first live run. Value format: the DB instance ARN.

### Changes (`infra/src/bootstrapStack.ts`)
- `Cdn` split in three: `CdnDistributionCreate` (`CreateDistribution`, `TagResource` on `*`, only with
  `aws:RequestTag/project = ascrum-migration`); `CdnDistributionChangeTagged` (`Update`/`Delete
  Distribution`, `UntagResource` on `distribution/*`, only with `aws:ResourceTag/project`);
  `CdnUnscopable` (origin access controls, response headers policies, documented as unscopable).
- Boundary `DatabaseSecret`: `GetSecretValue`/`DescribeSecret` on `rds!*` only with
  `aws:ResourceTag/aws:rds:primaryDBInstanceArn = arn:…:rds:<region>:<account>:db:ascrum-demo-db`.
- `RegisterDemoTaskDefinition` on `task-definition/ascrum-demo-api:*` (optional item 3);
  `DeregisterTaskDefinitions` stays on `*` + region.
- New deploy-role deny `NeverImportResources`: `CreateChangeSet` when `cloudformation:ImportResourceTypes`
  is present. Why: `TagResource` with the demo tag in the request is allowed on any distribution id, so a
  change set importing a foreign distribution could tag it and then update or delete it. A deploy imports
  nothing. Not asked for; it closes the one path the tag scoping opens.
- Tests: the "one unscoped exception" test now names only `CdnUnscopable` (OAC/RHP actions only) and
  pins the create condition; new tests for the distribution scoping (including that the demo's
  distribution carries the tag), the boundary secret condition, the task family, and the import deny.
  The exact allow-list (R27) updated. README table and step 0 corrected.

### Breakages, round 4 (one at a time, exact match required, never committed; scratchpad runner)
All 11 red: create without RequestTag; change without ResourceTag; change on `*`; `UpdateDistribution`
moved into `CdnUnscopable`; RequestTag value `*`; boundary condition removed; boundary `db:*`;
`RegisterTaskDefinition` on `*`; import deny inverted; `CreateDistributionWithTags` back; demo stacks
untagged. (The runner now refuses a pattern that does not occur exactly once, so no false survivors.)

### Gates (this session, every AWS credential source at `/dev/null`, `AWS_PROFILE` unset)
- infra `pnpm verify` exit 0: "All matched files use Prettier code style!", "Test Files 9 passed (9)",
  "Tests 120 passed (120)", "Successfully synthesized to …/infra/cdk.out".
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0:
  "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "41 passed" (e2e).
- No AWS command run; nothing read `~/.aws`.

### Still only provable live (added this round)
The RDS-managed secret's tag key (Q-p5-infra-10: a "secret AccessDenied" at task start means the key
differs); whether CloudFormation's distribution create needs `cloudfront:CreateConnectionGroup` (not
granted; would fail closed with AccessDenied naming it); that the tagged create passes the stack tags in
the request (the template carries them; pinned).

## 2026-11-24, policy size (worker): the first live bootstrap failed on an IAM quota
Branch `convert/p5-infra-policy-size` from `origin/migration` (after PR #69 merged as `472274a`). The
worktree again held `MIGRATION.md`, `spec/deviations.md` and `spec/journal.md` staged in reverse;
restored to HEAD, not committed.

### The failure (owner's `cdk deploy AscrumBootstrap`, owner's credentials, dedicated account)
`CREATE_FAILED | AWS::IAM::ManagedPolicy | CfnExecutionPolicy … "Cannot exceed quota for PolicySize:
6144 (Service: Iam, Status Code: 409 …)" HandlerErrorCode: ServiceLimitExceeded`. The stack rolled back.

### Cause, and why no offline test caught it
IAM limits a managed policy to 6,144 characters without whitespace. The CloudFormation execution policy
had grown, statement by statement over rounds 2-4 (DEV-05 named every ARN, DEV-10 split CloudFront and
the task definitions), to 23 statements: 9,601 characters in template form, 8,180 resolved with
worst-case values. Every test pinned *what* the policy allows (actions, resources, conditions, denies),
none pinned how big it is, and the only size test was CloudFormation's inline template limit. I knew
the quota exists; I never measured against it. Same lesson as DEV-10 in a new form: a property AWS
enforces at deploy time needs an offline test, or the first live run is the test.

### Fix
- `infra/src/bootstrapStack.ts`: the execution statements are grouped into five managed policies,
  `ascrum-cdk-cfn-execution-{network,compute,data,cdn,iam}`, all attached to `ascrum-cfn-exec` (5 of
  the 10 a role may have). Every statement is unchanged (Sids, actions, resources, conditions); only
  the grouping is new. `EXECUTION_POLICY_PARTS` names the parts. Deploy role and boundary unchanged
  (both far under their limits, below).
- New `infra/src/policyLimits.test.ts` with helper `infra/src/testPolicySize.ts`: resolves every
  policy document in every stack as CloudFormation would, with the longest values an account could
  give it (12-digit account id, partition `aws-us-gov`, a 14-character region such as
  `ap-southeast-7`, URL suffix `sc2s.sgov.gov`, the longest `owner/repo` GitHub allows; any other Ref
  or GetAtt as 256 characters), and asserts IAM's quotas
  (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html): each managed policy
  ≤ 6,144; each role's inline policies together ≤ 10,240; ≤ 10 managed policies per role; each trust
  policy ≤ 2,048. Also CloudFormation's per-template counts (≤ 500 resources, 200 outputs, 200
  parameters). An unknown intrinsic fails the test rather than being skipped.
- The same file pins the split: the execution role holds exactly the five parts, and the union of their
  statements equals, exactly and without repeats, the 23 statements of the single policy before the
  split, kept as `infra/src/cfnExecutionStatements.json` (template form, captured from `472274a`'s
  synth; no account values). A later policy change updates that file in the same commit, on purpose.
- `bootstrapStack.test.ts` reads the union of the parts (allow-list R27 and the rest unchanged).
  README table names the five policies and the new test.

### Red/green
- The new tests against the old single policy (same 23 statements in one policy, put back by a scratch
  script): 2 red: "bootstrap CfnExecutionPolicy1CBEA9D3: expected 8180 to be less than or equal to
  6144", and the parts test. The union test stays green there, as it should (same statements).
- Breakages on the split, one at a time, all red: an action dropped from a statement; a resource
  widened (`service/*`); a part not attached to the role; a statement repeated in another part; a
  condition dropped; the trust limit set to 1,000 (proves the trust policies are actually resolved
  and measured: the deploy role's is 1,285 worst case).

### Sizes (minified JSON; template form = what `cdk.out` holds; worst case = resolved as above)
| Policy | Before: template / worst case | After: template / worst case |
|---|---|---|
| execution (single) | 9,601 / 8,180 (23 statements) | split, below |
| execution-network | | 1,722 / 1,707 (4) |
| execution-compute | | 2,957 / 2,367 (5) |
| execution-data | | 2,444 / 1,865 (5) |
| execution-cdn | | 1,211 / 1,103 (4) |
| execution-iam | | 1,419 / 1,290 (5) |
| deploy role inline (DefaultPolicy) | 3,585 / 3,015 (12) | unchanged; limit 10,240 |
| boundary | 1,132 / 872 (4) | unchanged; limit 6,144 |
| demo task execution role inline | 669 / 1,016 (4) | unchanged; limit 10,240 |
| deploy role trust | 1,070 (longest repo) / 1,285 | unchanged; limit 2,048 |

### Other quota risks checked
- Demo roles: the task execution role's inline policy is 1,016 worst case; the task role has none;
  neither has managed policies. Trust policies 133.
- Templates: resources 11 / 1 / 44, outputs 3 / 1 / 4, parameters 2 / 0 / 0 (bootstrap / registry /
  demo), far under 500 / 200 / 200; the inline template size (51,200) was already pinned and still passes.
- Nothing else found at risk. Not testable offline: account-level quotas (managed policies per account,
  roles per account), which a dedicated account will not approach.

### Gates (this session, every AWS credential source at `/dev/null`, `AWS_PROFILE` unset)
- infra `pnpm verify` exit 0: "All matched files use Prettier code style!", "Test Files 10 passed (10)",
  "Tests 125 passed (125)", "Successfully synthesized to …/infra/cdk.out".
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0:
  "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "41 passed" (e2e).
- No AWS command run; nothing read `~/.aws`. The owner re-runs the bootstrap deploy after the failed
  stack is deleted (infra/README.md step order unchanged).

## 2026-11-24, OIDC subject (worker): GitHub forces the immutable subject; the deploy role trusted the name form
Branch `convert/p5-infra-oidc-subject` from `origin/migration` (after #72 merged as `ac6f307`; the
owner then deployed `AscrumBootstrap` successfully). The worktree again held `MIGRATION.md`,
`spec/deviations.md` and `spec/journal.md` staged in reverse; restored to HEAD, not committed.

### The live finding (owner's setup, README step 3)
GitHub's read-back of the repository's subject customisation:
`{"use_default":false,"use_immutable_subject":true,"include_claim_keys":["repo","context","job_workflow_ref"],"sub_claim_prefix":"repo:<owner>@<owner id>/<repo>@<repo id>"}`
(the real values are public, but this file does not repeat names or ids). A re-PUT with
`use_immutable_subject=false` was ignored. Tokens therefore start with the id form, while the deploy role
trusted `repo:<owner>/<repo>:environment:aws-demo:job_workflow_ref:…`: the role cannot be assumed (fails
closed, nothing exposed).

### Why offline review could not see it
The subject format is decided by GitHub per repository at token time. Round 1 used the then-documented
name form, and GitHub introduced immutable subjects in 2026 (opt-in for existing repositories, forced
for repositories created, renamed or transferred after mid-July 2026). Nothing in the repo or the
synthesised template can show which form a given repository gets; only the read-back (or a token) does.
What I could have done: read GitHub's current OIDC reference in round 1 instead of relying on the
format I knew; the immutable section was already there.

### Sources (read 2026-11-24)
- GitHub, OIDC reference, https://docs.github.com/en/actions/reference/security/oidc: immutable syntax
  `repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH`; "`owner_id` and `repo_id` are always included
  in the `repo` segment of the `sub` claim", also "when you customize claims with `include_claim_keys`";
  "You can't remove these IDs from the immutable format"; the combined example
  `repo:octo-org/octo-repo:environment:prod:job_workflow_ref:octo-org/octo-automation/.github/workflows/oidc.yml@refs/heads/main`
  (name form only); claims table: `job_workflow_ref` "the ref path to the reusable workflow".
- GitHub REST, https://docs.github.com/en/rest/actions/oidc: `use_immutable_subject` (PUT, "Whether to opt
  in to the immutable OIDC subject claim format") and `sub_claim_prefix` (GET only, no description).
- GitHub changelog, https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens:
  `@` separator; forced for repositories created, renamed or transferred after July 15, 2026; no
  statement on opting out.
- Microsoft Entra, https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects:
  same `repo:<owner>@<owner_id>/<repo>@<repo_id>:…` form; no `job_workflow_ref` example.

**Certain:** the subject starts with `sub_claim_prefix` (the documented `repo` segment with ids) followed
by `:environment:aws-demo` (the `context` claim key for a job in an environment, as before).
**Not documented:** whether `job_workflow_ref` inside the immutable subject stays the name path. No page
gives an immutable example with it; the claim itself is documented as the name path. I trust that form
(Q-p5-infra-11), no wildcard; if the first run's assume fails while the prefix matches, that part is wrong.

### Fix
- `infra/src/bootstrapStack.ts`: `subjectPrefix()` builds `repo:<owner>@<owner id>/<repo>@<repo id>`;
  `trustedSubjects()` returns exactly two `StringEquals` strings, `<prefix>:environment:aws-demo:job_workflow_ref:<owner>/<repo>/.github/workflows/{deploy,destroy}-demo.yml@refs/heads/migration`.
  No name-form fallback (reasoning in Q-p5-infra-11: it would reopen the subject-recycling gap the ids
  close). New output `OidcSubjectPrefix` to compare with GitHub's read-back.
- New required context `githubOwnerId`, `githubRepositoryId` (digits, no leading zero), falling back to
  GitHub's `GITHUB_REPOSITORY_OWNER_ID` / `GITHUB_REPOSITORY_ID` in a workflow (the deploy and destroy
  runs synthesise the app); `package.json`'s `synth` passes example ids locally, as it does the repo.
- Tests: the exact subjects; no name-form subject and no `*`/`?`; the prefix and the output; the ids
  required and digits only (8 bad values each), the env fallback; the size test now synthesises with the
  longest ids (19 digits) and checks it did. README step 1 (how to get the ids, the deploy command) and
  step 3 (`use_immutable_subject` may be forced; what the read-back must show; compare with the output).

### Breakages (one at a time, exact match, never committed), 11/11 red
Name-form subject; ids swapped; `job_workflow_ref` in an id form; a name-form fallback added; id
validation removed; id pattern allowing `*`; env fallback dropped; `sub` under `StringLike`; the prefix
output dropped; wildcard environment; the size test fed short ids. The last one first **survived** (the
trust is far under 2,048 either way); I added a test that the size test's stacks were built from the
worst-case values, and it is red now.

### Owner's re-deploy (updates the existing stack)
```sh
cd infra
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER_ID=$(gh api "repos/$REPO" -q .owner.id)
REPO_ID=$(gh api "repos/$REPO" -q .id)
pnpm exec cdk deploy AscrumBootstrap -c githubRepository="$REPO" -c githubOwnerId="$OWNER_ID" -c githubRepositoryId="$REPO_ID"
```
Then compare `OidcSubjectPrefix` with `gh api "repos/$REPO/actions/oidc/customization/sub" -q .sub_claim_prefix`.

### Gates (this session, every AWS credential source at `/dev/null`, `AWS_PROFILE` unset)
- infra `pnpm verify` exit 0: "All matched files use Prettier code style!", "Test Files 10 passed (10)",
  "Tests 128 passed (128)", "Successfully synthesized to …/infra/cdk.out". Deploy role trust policy:
  1,150 characters in the template, 1,365 worst case (limit 2,048).
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0:
  "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "41 passed" (e2e).
- No AWS command run; nothing read `~/.aws`.

## 2026-11-24, live run 1 (worker): the image-scan step and the evidence download
Branch `convert/p5-infra-live-run-1` from `origin/migration` (`57ce901`, after #73; the owner updated the
bootstrap and `OidcSubjectPrefix` matched GitHub's read-back). The worktree was clean this time.

### What the first live **Deploy demo (AWS)** run proved (run 45552933643 on `57ce901`)
- The gate passed.
- The OIDC sign-in worked. So the immutable `…:environment:aws-demo:job_workflow_ref:…` subject of
  Q-p5-infra-11 is right, including the name form for `job_workflow_ref`.
- `AscrumDemoRegistry` deployed and the image was pushed.
- Destroy ran, and the leftover check printed "Demo stacks still present: none … Remaining: 0 … OK:
  nothing from the demo remains." (kept: the OIDC provider and the budget).

So AC-AWS-01, -02 and -04 have now run live once.

### Failure 1: the image-scan step
`aws ecr wait image-scan-complete …` failed at once: `Waiter ImageScanComplete failed: An error occurred
(ScanNotFoundException): Image scan does not exist for the image with '{imageDigest:'null',
imageTag:'57ce901…'}' in the repository with name 'ascrum-demo-api'`.

**Diagnosis** (AWS docs, read 2026-11-24):
- https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-basic-enabling.html: "By default,
  Amazon ECR turns on basic scanning for all private registries" and "By default all of your repositories
  are set for **Manual** scanning. You can optionally configure scan on push by specifying **Scan on push
  filters**" (registry level).
- https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-basic.html: "Any repositories
  that don't match a scan on push filter are set to the **manual** scan frequency which means you must
  manually start the scan."
- https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_PutImageScanningConfiguration.html: "The
  `PutImageScanningConfiguration` API is being deprecated, in favor of specifying the image scanning
  configuration at the registry level." That is the repository-level `scanOnPush` the registry stack sets.
- https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_StartImageScan.html: "A basic image scan
  can only be started once per 24 hours on an individual image. This limit includes if an image was
  scanned on initial push."
- https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_ImageScanStatus.html: status is one of
  `IN_PROGRESS | COMPLETE | FAILED | UNSUPPORTED_IMAGE | ACTIVE | PENDING | SCAN_ELIGIBILITY_EXPIRED |
  FINDINGS_UNAVAILABLE | LIMIT_EXCEEDED | IMAGE_ARCHIVED`.
- The CLI waiter also stopped at once on that error, so a scan that has not appeared yet fails it
  immediately (seen in the run, not from the docs).

Most likely no scan was ever started: the new account's registry defaults to manual scanning, and the
deprecated repository setting is not what decides. A race right after the push also fits a single failed
run. One run cannot tell the two apart, so the fix covers both.

**Fix:** `infra/scripts/imageScan.ts` is now the whole step.
- It polls `describe-image-scan-findings` for up to 2 minutes for a scan to appear. ScanNotFoundException
  means "not yet"; any other error stops the step.
- If no scan appears, it calls `ecr start-image-scan`, then polls for up to 15 minutes for the result.
- It passes **only** `COMPLETE` with zero HIGH and zero CRITICAL findings. Every other status, a timeout
  or an error fails the step.
- The summary goes into the evidence: `status`, `completedAt`, `startedByThisRun`, counts and findings,
  with no registry id.
- The deploy role gets `ecr:StartImageScan` on `ascrum-demo-api` only. The SAR
  (list_amazonelasticcontainerregistry.html) lists `repository*` as its resource type.

Rejected: setting the registry's scanning configuration in the bootstrap
(`AWS::ECR::RegistryScanningConfiguration`). It is account-wide and replaces whatever rules the account
already has, so it is unsafe in a shared account.

Risk left: re-running the same commit within 24 h could hit the start limit (LIMIT_EXCEEDED). That fails
closed, with the reason in the log.

**The owner must update the bootstrap**, because the new permission is on the deploy role; command below.

### Failure 2: the evidence job
`actions/download-artifact@v8` listed `destroy-evidence` (ID 14994637907) and `deploy-evidence`,
downloaded deploy-evidence, then failed with `Unable to download artifact(s): No artifacts found for ID:
14994637907` and the hint "Are you trying to download from a different run? Try specifying a
github-token with `actions:read` scope."

**Diagnosis:**
- The hint is the action's generic message for any not-found. This was the same run, and the listing
  had just returned that id.
- The destroy job had uploaded the artifact seconds before.
- The action's README (https://github.com/actions/download-artifact) documents no retry.
- I could not find a documented cause. The evidence points to a transient lookup failure right after
  upload, not to permissions: the same token had just listed the artifact. This is a likely cause, not a
  proven one.

**Fix** (no `continue-on-error`, which stays banned in these workflows):
- The evidence job fetches each expected artifact by name with `gh run download`. The job already has
  `actions: read`.
- v4 artifacts are available through the REST API immediately after upload:
  https://github.blog/changelog/2023-12-14-github-actions-artifacts-v4-is-now-generally-available/
- Up to 5 attempts, waiting 10/20/30/40 s between them.
- An artifact is expected when its job ran (`needs.<job>.result != skipped`).
- An artifact that never arrives is written to `MISSING.txt` in the evidence.
- The single artifact is uploaded `if: always()`, and then the last step fails the job if `MISSING.txt`
  is non-empty.

So a transient error is retried, and a real loss shows up both in the artifact and as a red job.

### Tests and breakages
- `scripts/imageScan.test.ts` (7 tests):
  - a clean scan on push passes;
  - ScanNotFound is waited out;
  - when no scan ever appears, one is started, once, after the wait;
  - it never passes on NOT_FOUND, IN_PROGRESS, FAILED, UNSUPPORTED_IMAGE, FINDINGS_UNAVAILABLE,
    LIMIT_EXCEEDED or ACTIVE;
  - any HIGH or CRITICAL finding fails it;
  - other errors stop it;
  - no account id appears in the summary.
- `scripts/entrypoints.test.ts`, the scan step as the workflow runs it, with the fake `aws`:
  - a clean scan passes and writes the evidence;
  - HIGH or CRITICAL fails;
  - ScanNotFound throughout calls start-image-scan, and the step fails;
  - a refused start fails.
- `scripts/entrypoints.test.ts`, the evidence steps with a stand-in `gh`:
  - 2 transient failures are retried, both parts arrive and the check passes;
  - a part that never arrives goes into MISSING.txt, the rest is kept, and the check fails;
  - a skipped job's artifact is not expected.
- `scripts/workflows.test.ts`:
  - the scan step is exactly the script call, with no env and no poll override;
  - no `download-artifact`;
  - the collect step's env and permissions;
  - the upload runs on `always()`, and the check is the last step.
- The deploy role allow-list (R27) now has `ecr:StartImageScan`.
- Breakages, applied one at a time; all 17 went red:
  - Scan gate: a missing scan passes; findings ignored; HIGH not blocking; a scan is never started; a
    refused start is ignored; any error treated as "no scan yet"; no wait for a scan on push;
    IN_PROGRESS counted as done; main exits 0 on a failed verdict; the step masked with `|| true`; no
    StartImageScan permission.
  - Evidence: no retry; a missing part not recorded; the check passes anyway; upload only on success;
    destroy evidence not expected; back to download-artifact.

### Owner: update the bootstrap (adds ecr:StartImageScan to the deploy role), then re-run the deploy
```sh
cd infra
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER_ID=$(gh api "repos/$REPO" -q .owner.id)
REPO_ID=$(gh api "repos/$REPO" -q .id)
pnpm exec cdk deploy AscrumBootstrap -c githubRepository="$REPO" -c githubOwnerId="$OWNER_ID" -c githubRepositoryId="$REPO_ID"
```

### Gates (this session, every AWS credential source at `/dev/null`, `AWS_PROFILE` unset)
- infra `pnpm verify` exit 0: "All matched files use Prettier code style!", "Test Files 11 passed (11)",
  "Tests 144 passed (144)", "Successfully synthesized to …/infra/cdk.out".
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0:
  "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "41 passed" (e2e).
- No AWS command run; nothing read `~/.aws`.
- Not provable offline: whether `gh run download` fetches an artifact of the run that is still in
  progress on the first try (documented for v4 artifacts; the retries and MISSING.txt cover a miss), and
  which of the two scan cases the next live run hits (`startedByThisRun` in the evidence will say).

## 2026-11-25, live run 2 (worker): ECR cannot scan the image index BuildKit pushed
Branch `convert/p5-infra-live-run-2`, reset to `origin/migration` (`38bceb9`, after #74). The owner had
updated `AscrumBootstrap`, so the deploy role has `ecr:StartImageScan` on `repository/ascrum-demo-api`.

### What happened (run 45640099889 on `38bceb9`)
- Green: the gate, the OIDC sign-in, the registry deploy, the build and the push. Destroy, the leftover
  check and the evidence job (the live-run-1 retry fix) were also green.
- `imageScan.ts` waited about 2 minutes, logged "No scan appeared after the push (the registry scans
  this repository manually); starting one.", and then StartImageScan failed:
  `UnsupportedImageTypeException … An artifact with media type 'application/vnd.oci.image.index.v1+json'
  cannot be scanned.`
- The script threw, so the step failed closed, which is what it should do. The demo stack was skipped.

### Cause
The runner's Docker uses the containerd image store, and BuildKit adds a provenance attestation by
default. The build log of run 2 shows `exporting manifest sha256:…`, `exporting attestation manifest
sha256:…` and `exporting manifest list sha256:…`, so the tag named an OCI image index holding the image
and an attestation manifest. ECR basic scanning refuses an index.

Docs (read 2026-11-25):
- https://docs.docker.com/build/metadata/attestations/: "Provenance attestations with the `mode=min`
  level are added to images by default."; "Attestations attach to images as a manifest in the image
  index."; "To build attestations with the `docker` driver, turn on the containerd image store."; "opt
  out of attestations with `--provenance=false --sbom=false`."
- https://docs.docker.com/engine/storage/containerd/: "The containerd image store is the default storage
  backend for Docker Engine 29.0 and later on fresh installations." Attestations "use image indices
  that the classic store doesn't support."
- https://docs.docker.com/build/exporters/: the image exporters "support both Docker media types
  (default) and OCI media types".
- https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_StartImageScan.html:
  `UnsupportedImageTypeException`, "The image is of a type that cannot be scanned."
- https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_ImageDetail.html: DescribeImages returns
  `imageManifestMediaType`, "The media type of the image manifest", and `imageDigest`.
- None of the ECR user-guide scanning pages I read (image-scanning, image-scanning-basic,
  troubleshooting, multi-architecture push) says which manifest media types basic scanning accepts. The
  run's error message is the primary evidence that an index is refused.

None of the docs says outright what a single-platform `docker build` pushes without attestations when the
containerd store is on. **So I measured it locally** (Docker Engine 29.6.2, containerd snapshotter, buildx
0.35.0, a throwaway local `registry:3` container on 127.0.0.1, an `alpine` Dockerfile; no AWS):

| build command | Content-Type of the pushed tag |
|---|---|
| `docker build` (the run-2 command) | `application/vnd.oci.image.index.v1+json`: an amd64 image plus an `unknown/unknown` manifest with `vnd.docker.reference.type: attestation-manifest` |
| `docker build --provenance=false --sbom=false` | `application/vnd.oci.image.manifest.v1+json` |
| `docker build --platform linux/amd64 --provenance=false --sbom=false` | `application/vnd.oci.image.manifest.v1+json` |

So turning attestations off is enough to get a single OCI image manifest. No `--output
type=image,oci-mediatypes=…` is needed: ECR accepts OCI and Docker v2 manifests alike.

### Item 4: was run 1's "no scan on push" the same cause?
Yes, at least in part. Run 1's build log (45552933643) has the same three lines, ending in `exporting
manifest list sha256:…`, so run 1 also pushed an index under the tag. `describe-image-scan-findings
--image-id imageTag=…` asks for the scan of the manifest that the tag names, which was the index, and an
index can never have a basic scan. So ScanNotFoundException in run 1 needs no other explanation.
The registry's default of manual scanning (live run 1 entry, quoted from the ECR docs) may also be true;
one run can't separate the two, and the ECR docs say nothing about how scan on push treats an index.
**My live-run-1 diagnosis was incomplete.** I blamed manual scanning only and didn't look at what the
build actually pushed.

### Decision: option (a), one image manifest, and the gate checks it
- **The build** is now `docker build --platform linux/amd64 --provenance=false --sbom=false …`.
  - The platform pin matches the Fargate task (`CpuArchitecture.X86_64` in `demoStack.ts`), so it
    doesn't depend on what the runner happens to be.
  - The pushed manifest is what the immutable tag names (`TagMutability.IMMUTABLE` in `registryStack.ts`)
    and what the task definition runs, so the scanned image is the image that runs.
- **`imageScan.ts`** now starts with `ecr describe-images --image-ids imageTag=…`.
  - Exactly one image must come back, with a digest and an `imageManifestMediaType` that is a single
    image manifest (`application/vnd.oci.image.manifest.v1+json` or
    `application/vnd.docker.distribution.manifest.v2+json`).
  - Anything else fails the step before any scan is waited for: an index, a manifest list, an artifact,
    a missing type, no image or two. The status is `UNSCANNABLE_MEDIA_TYPE`, and the media type and
    digest go in the evidence.
  - It then waits for, starts and reads the scan **by digest**, so the scanned image is the checked one.
  - Every non-COMPLETE outcome, and any HIGH or CRITICAL finding, still fails, as before.
- **Why not option (b)** (resolve the index and scan the linux/amd64 child by digest):
  - (b) keeps the provenance attestation, which has real supply-chain value: who built the image, from
    which commit and with which builder.
  - But it needs index parsing in the gate, and a rule for choosing the child that must match what
    Fargate selects.
  - Nothing reads the attestation today: no consumer in the spec, and no signature verification.
  - Provenance for this demo already exists in the evidence artifact: `run.json` (sha, ref, actor, run
    URL) and the step timings.
  - So (a) is simpler, and its one assumption (a single manifest) is checked at run time, not trusted.
  - If attestations are wanted later, (b) plus a verification step is the way back.
- **IAM: no change and no bootstrap update.** The deploy role's `PushApiImageAndReadItsScan` statement
  already allows `ecr:DescribeImages`, `ecr:BatchGetImage`, `ecr:DescribeImageScanFindings` and
  `ecr:StartImageScan` on `ascrum-demo-api` (`bootstrapStack.ts`). Scanning by digest needs nothing new.

### Mistake: the test fakes hid the media type
The unit and entry-point fakes answered with single-manifest scan replies only. Nothing in them modelled
what the tag points to, so live run 1's fix passed every test and still could not work on the runner.
What changed:
- The fakes now answer `describe-images` with a media type.
- The index case is a test of its own, in both the unit tests and the entry-point tests.
- The build command is pinned in `workflows.test.ts`.

### Tests (5 new, 3 updated)
- `scripts/imageScan.test.ts`:
  - an OCI index fails before any scan, with the media type in the summary;
  - a manifest list, an artifact manifest, a missing type, a missing digest, no image or two images all
    fail;
  - `describe-images` failing (ImageNotFound) throws;
  - OCI and Docker v2 manifests are scanned by digest, never by tag.
- `scripts/entrypoints.test.ts`:
  - with the fake `aws`, an index under the tag fails the step;
  - no scan call is made, and the evidence names the media type;
  - the earlier scan cases now answer `describe-images` and match on `imageDigest=`.
- `scripts/workflows.test.ts`:
  - the build is exactly `docker build --platform linux/amd64 --provenance=false --sbom=false -f
    docker/api.Dockerfile -t "$REPOSITORY_URI:$IMAGE_TAG" .`;
  - there is one build and one push;
  - no `--attest`, `--push`, `BUILDX_NO_DEFAULT_ATTESTATIONS` or `oci-artifact` anywhere in the workflow;
  - the push step exists (its name changed, and the ordering check now asserts it was found).

Breakages, one at a time; all 9 went red:
- X1: no media-type check. 3 tests red: the unit index test, the manifest-list test, and the
  entry-point index test.
- X2: index accepted as scannable. The unit and entry-point index tests went red.
- X3: scan by tag again. The digest test and three entry-point tests went red.
- X4: take the first of several images. The manifest-list/no-image test went red.
- X5: the run-2 build command (`docker build` with no flags). The build pin went red.
- X6: provenance back on. The build pin went red.
- X7: SBOM allowed. The build pin went red.
- X8: no platform pin. The build pin went red.
- X9: an extra `--attest`. The build pin went red.

### Gates (this session; every AWS credential source at `/dev/null`, `AWS_PROFILE` unset; no `aws`, no
`cdk deploy` or `destroy`)
- infra `pnpm verify` exit 0: "All matched files use Prettier code style!", "Test Files 11 passed (11)",
  "Tests 149 passed (149)", "Successfully synthesized to …/infra/cdk.out".
- Can't be proven offline: that the runner's Docker gives the same result as my local Docker 29.6.2.
  If it doesn't, the gate stops at `UNSCANNABLE_MEDIA_TYPE` and names the type.

## 2026-11-25, live run 4 (worker): CloudFormation could not tag the VPC
Branch `convert/p5-infra-live-run-4`, reset to `origin/migration` (`b40417a`).

### What happened (run 45679955396 on `11da34b`)
- Green: the gate, OIDC, the registry and the push.
- **The image scan completed clean**: `COMPLETE`, counts `{}`, zero findings. That makes it the first
  completed scan, after the live-run-2 fix (one image manifest) and #78 (the apk floor).
- "Deploy the demo stack" failed about 30 s in: `AscrumDemo | CREATE_FAILED | AWS::EC2::VPC | Vpc …
  "Encountered a permissions error performing a tagging operation … Did not have IAM permissions to
  process tags on AWS::EC2::VPC resource." (HandlerErrorCode: UnauthorizedTaggingOperation)`.
- The same error came for `AWS::EC2::InternetGateway`. The rest was cancelled, and the stack reached
  ROLLBACK_COMPLETE.
- CDK's "Could not query CloudTrail … lookup role is missing cloudtrail:LookupEvents" is CDK's own
  diagnostic on the failed deploy. It doesn't affect the deploy, so I left it alone and grant nothing
  for it.

### Root cause: our ec2:CreateAction values could never match
- **The schemas.** The CloudFormation registry schemas (`CloudformationSchema.zip` from
  `schema.cloudformation.us-east-1.amazonaws.com`, read 2026-11-25) mark `AWS::EC2::VPC` and
  `AWS::EC2::InternetGateway` as `taggable: true` and `tagOnCreate: true`, with `ec2:CreateTags` in
  `handlers.create.permissions`. The same holds for Subnet, RouteTable and SecurityGroup. So the handler
  sends the tags in the create call's TagSpecifications.
- **What EC2 authorises.** EC2 then authorises `ec2:CreateTags` separately, and the request "fails if the
  user does not have permissions to use the `ec2:CreateTags` action"
  (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/supported-iam-actions-tagging.html).
- **The value it compares.** The same page shows the condition value as the bare API name:
  `"ec2:CreateAction" : "RunInstances"`, `"ec2:CreateAction" : "CreateVolume"`. It also says that
  condition values are case-sensitive.
- **What we had.** `NetworkTagOnCreate` had `ec2:CreateAction` = `["ec2:CreateVpc", …]`. With the prefix,
  `StringEquals` never matches "CreateVpc".
- **The fallback didn't help.** `NetworkChangeTagged` also allows `ec2:CreateTags`, but only on a resource
  that already carries `project=ascrum-migration`. A resource being created has no tags yet.
- So CreateVpc and CreateInternetGateway, which run first and in parallel, were refused for their tags.
  Subnet, RouteTable and SecurityGroup would have failed the same way; they were cancelled before they
  started.
- The service reference (`servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json`) confirms that
  `ec2:CreateAction` is a String key on `CreateTags`.

**Mistake: #69 trusted an untested assumption about how CloudFormation tags EC2 resources.** I wrote the
condition values in IAM action form (`ec2:CreateVpc`) and never checked the documented value form. The
test `DEV-p5-infra-05/-10 … a write on "*" only with its condition` then pinned exactly that wrong value.
So the test locked in the bug instead of catching it. The first review listed "EC2 create-time tags" as
provable only live, and this run is that proof.

### Fix (bootstrap; the owner must update it)
- **`NetworkTagOnCreate`** (network policy):
  - `ec2:CreateAction` is now `CreateVpc | CreateSubnet | CreateRouteTable | CreateInternetGateway |
    CreateSecurityGroup`, derived from the `NetworkCreate` actions with `ec2:` stripped.
  - It also requires `aws:RequestTag/project = ascrum-migration`, so a network resource is created
    already carrying the demo tag (the EC2 page lists `aws:RequestTag` for `ec2:CreateTags`).
  - Still no `ec2:CreateTags` on an existing resource that doesn't already carry the tag.
- **Not added: an `aws:TagKeys` restriction.**
  - CloudFormation adds its own `aws:cloudformation:*` tags (`cloudFormationSystemTags: true` in the EC2
    schemas), plus CDK's `Name` and `aws-cdk:*` keys.
  - I found nothing documenting whether the system tags appear in `aws:TagKeys`, so an allow-list of
    keys would be another untested assumption.
  - `ec2:CreateAction` plus `aws:RequestTag/project` already confine the statement to tags on new demo
    resources.
- **Two gaps found by the full coverage check** (below), both on resources scoped by name:
  - **`WebBucket`** (data policy) gains `s3:TagResource`, `s3:UntagResource` and
    `s3:ListTagsForResource`, on the web bucket's ARN only.
    - The S3 API reference for CreateBucket says: "You must have the `s3:TagResource` permission to
      create a general purpose bucket with tags."
    - The `AWS::S3::Bucket` schema lists `s3:TagResource` in its create permissions and
      `s3:ListTagsForResource` in its read permissions. Our `s3:Get*` covers neither.
    - The service reference lists `bucket` as a resource type for all three actions.
    - `s3:DeleteBucketTagging` (in the schema) isn't an IAM action: the service reference maps the
      DeleteBucketTagging API to `s3:PutBucketTagging`, which we already had.
  - **`DemoRolesTagReadAndDelete`** (iam policy) gains `iam:ListRoleTags`, on `role/AscrumDemo*` only.
    The `AWS::IAM::Role` schema lists it under tagging permissions.

### Coverage: every type in the AscrumDemo template
Source for each row: the type's registry schema (`tagging`, `handlers.create.permissions`). Rows marked
taggable are taggable and tagOnCreate, and the template gives them the `project` tag. `src/demoTagging.ts`
holds the table and `src/demoTagging.test.ts` checks it against the synthesised template.

| Type | Tagging actions on create | Allowed by | Before this fix |
|---|---|---|---|
| EC2::VPC, Subnet, RouteTable, InternetGateway, SecurityGroup | `ec2:CreateTags` (ec2:CreateAction) | NetworkTagOnCreate | **denied** (prefixed values) |
| EC2::Route, SecurityGroupIngress/Egress, SubnetRouteTableAssociation, VPCGatewayAttachment | not taggable | n/a | ok |
| ECS::Cluster, Service, TaskDefinition | `ecs:TagResource` | Containers (named ARNs) | ok |
| ElasticLoadBalancingV2::LoadBalancer, TargetGroup, Listener, ListenerRule | `elasticloadbalancing:AddTags` | LoadBalancer (named ARNs) | ok |
| RDS::DBInstance, DBSubnetGroup | `rds:AddTagsToResource` | Database (named ARNs) | ok |
| Logs::LogGroup | `logs:TagResource` | Logs (named ARN) | ok |
| S3::Bucket | `s3:TagResource`, `s3:PutBucketTagging`, `s3:ListTagsForResource` | WebBucket (bucket ARN) | **gap**: TagResource, ListTagsForResource |
| S3::BucketPolicy | not taggable | n/a | ok |
| IAM::Role | `iam:TagRole`, `iam:ListRoleTags` | DemoRolesTagReadAndDelete | **gap**: ListRoleTags |
| IAM::Policy | not taggable | n/a | ok |
| CloudFront::Distribution | `cloudfront:CreateDistribution` + `cloudfront:TagResource` (aws:RequestTag) | CdnDistributionCreate | ok |
| CloudFront::Function | `cloudfront:TagResource` (aws:RequestTag) | CdnDistributionCreate | ok |
| CloudFront::OriginAccessControl, ResponseHeadersPolicy | not taggable | n/a | ok |
| CDK::Metadata | none (added by the CLI) | n/a | ok |

**What the table can't show.** The schemas' create-permission lists also name feature-dependent calls
that the template doesn't use. A script compared every schema permission with our statements, and these
were the leftovers:
- VPC: `ec2:CreateVpcEncryptionControl`;
- VPCGatewayAttachment: `ec2:AttachVpnGateway`;
- SubnetRouteTableAssociation: `ec2:ReplaceRouteTableAssociation`;
- Listener and ListenerRule: `cognito-idp:DescribeUserPoolClient`;
- LoadBalancer: `elasticloadbalancing:ModifyCapacityReservation`;
- TargetGroup: `RegisterTargets`;
- LogGroup: data-protection and delivery calls;
- DBInstance: read replicas and restores;
- Bucket: replication, website, lifecycle and so on;
- IAM::Policy: user and group policies.

I didn't add any of these: each belongs to a property the template doesn't set. The table covers tagging
only. A non-tagging gap on a later resource would still show up only live.

### Tests (4 new, 3 updated)
- `src/demoTagging.test.ts` (new):
  - every type in the synthesised AscrumDemo template has a row, and no row is stale;
  - each taggable type carries `project=ascrum-migration` in the template, and each untagged type has no
    `Tags`;
  - every row's tagging actions are allowed by the statement the row names;
  - `ec2:CreateAction` holds exactly the bare names of the `NetworkCreate` creates, with the demo tag in
    the request, and covers every network type tagged on create.
  - The in-process synth leaves out `AWS::CDK::Metadata`, which the CLI adds; the test names that one
    type explicitly.
- `src/bootstrapStack.test.ts`: the allow-list for `WebBucket` and `DemoRolesTagReadAndDelete`, and the
  `NetworkTagOnCreate` condition (bare names plus `aws:RequestTag/project`).
- `src/cfnExecutionStatements.json`, the pre-split fixture that pins the union of the parts: the same
  three statements changed. The split test still passes.

### Policy sizes (worst case, minified, limit 6,144)
| Policy | Before | After |
|---|---|---|
| network | 1,707 | 1,731 |
| compute | 2,367 | 2,367 |
| data | 1,865 | 1,926 |
| cdn | 1,103 | 1,103 |
| iam | 1,290 | 1,309 |

### Owner: update the bootstrap, then re-run the deploy
Three managed policies change in place; their names are unchanged, so nothing is replaced. The deploy
role, the trust policy and the boundary don't change. What `cdk diff AscrumBootstrap` should show:
- `ascrum-cdk-cfn-execution-network`, NetworkTagOnCreate: the condition `ec2:CreateAction` changes from
  `ec2:CreateVpc, …` to `CreateVpc, …`, and `aws:RequestTag/project: ascrum-migration` is added.
- `ascrum-cdk-cfn-execution-data`, WebBucket: adds `s3:ListTagsForResource`, `s3:TagResource` and
  `s3:UntagResource`.
- `ascrum-cdk-cfn-execution-iam`, DemoRolesTagReadAndDelete: adds `iam:ListRoleTags`.

```sh
cd infra
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER_ID=$(gh api "repos/$REPO" -q .owner.id)
REPO_ID=$(gh api "repos/$REPO" -q .id)
pnpm exec cdk diff AscrumBootstrap -c githubRepository="$REPO" -c githubOwnerId="$OWNER_ID" -c githubRepositoryId="$REPO_ID"
pnpm exec cdk deploy AscrumBootstrap -c githubRepository="$REPO" -c githubOwnerId="$OWNER_ID" -c githubRepositoryId="$REPO_ID"
```

### Breakages (one at a time; all 9 red)
- T1: the `ec2:`-prefixed `ec2:CreateAction` values of #69. Red: the bare-names test, the condition
  test and the pre-split union test.
- T2: no `aws:RequestTag/project`. Red: the same three tests.
- T3: no `ec2:CreateAction`, which would allow CreateTags whenever the demo tag is requested. Red: the
  same three tests.
- T4: no `s3:TagResource`. Red: the row-allowed test, the allow-list and the union.
- T5: no `s3:ListTagsForResource`. Red: the same three tests.
- T6: no `iam:ListRoleTags`. Red: the same three tests.
- T7: a type without a row (`AWS::EC2::Route` removed). Red: the every-type test.
- T8: a row naming the wrong statement. Red: the row-allowed test.
- T9: a tagged type marked untagged (the VPC). Red: the template-tags test.

### Gates (this session; every AWS credential source at `/dev/null`, `AWS_PROFILE` unset; no `aws`, no
`cdk deploy`, `diff` or `destroy`)
- infra `pnpm verify` exit 0:
  - "All matched files use Prettier code style!";
  - typecheck clean;
  - "Test Files 12 passed (12)", "Tests 155 passed (155)";
  - "Successfully synthesized to …/infra/cdk.out".
- The CLI-synthesised `cdk.out/AscrumDemo.template.json` has 29 types. These are the table's 29 rows,
  including `AWS::CDK::Metadata`.
- Can't be proven offline: that CloudFormation's EC2 handlers send the tags as TagSpecifications, which
  the schemas' `tagOnCreate: true` says. If one tags after create instead, `ec2:CreateAction` is absent,
  this statement doesn't apply, and the run fails closed the same way. That would be the next live
  finding, not a silent widening.

## 2026-11-25, live run 4, round 2 (worker): security-review findings sec-01 and sec-02 on #82
The `security-reviewer` agent's second review of #82 raised two findings. Both are non-blocking, but the
owner wanted them in #82 so the bootstrap is updated only once. The new commits sit on top of the regular
reviewer's commit `25f9d77`, with no force-push.

### sec-01 (medium): NetworkCreate allowed child creates in any VPC
**Problem.** `NetworkCreate` allowed `ec2:CreateSubnet`, `ec2:CreateSecurityGroup` and
`ec2:CreateRouteTable` on `*`, conditioned on the region only.
- Its comment, "Creating something touches nothing that exists", was **wrong**, and it was mine (#69): a
  child create attaches the new resource to an existing VPC.
- #82's tag-on-create fix makes this path work end to end, so the role could have put a demo-tagged
  subnet, security group or route table into any VPC in the region.

**Source.** Service Authorization Reference, EC2
(https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html, Actions table,
read 2026-11-25; the same data is in
https://servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json, version v1.5). `*` marks a required
resource type:

| Action | Resource types (condition keys used here) |
|---|---|
| CreateVpc | `vpc*` (aws:RequestTag), `ipam-pool`, `ipv6pool-ec2` (not used) |
| CreateInternetGateway | `internet-gateway*` (aws:RequestTag) |
| CreateSubnet | `subnet*` (aws:RequestTag), `vpc*` (aws:ResourceTag), `ipam-pool` (not used) |
| CreateRouteTable | `route-table*` (aws:RequestTag), `vpc*` (aws:ResourceTag) |
| CreateSecurityGroup | `security-group*` (aws:RequestTag), `vpc` (aws:ResourceTag; listed, not marked required) |

Every action supports the key I needed on the resource type I needed it on, so I didn't need to raise a
question.

**Fix** (`bootstrapStack.ts`): `NetworkCreate` is split into four statements, each also bound to the
region.
- `NetworkCreateTagged`: `ec2:CreateVpc` and `ec2:CreateInternetGateway` on `vpc/*` and
  `internet-gateway/*`, only with `aws:RequestTag/project = ascrum-migration`.
- `NetworkCreateInDemoVpc`: the three child creates on `vpc/*`, only with
  `aws:ResourceTag/project = ascrum-migration`.
- `NetworkCreateChildTagged`: the three child creates on `subnet/*`, `security-group/*` and
  `route-table/*`, only with `aws:RequestTag/project = ascrum-migration`.
- `NetworkPrefixLists`: `ec2:GetManagedPrefixListEntries` on `*`. It was in NetworkCreate; it's a read,
  and the region condition stays.

**Why (b) and (c) are separate statements.** A request's tags are in the request context for every
resource the call touches. If one statement put `aws:RequestTag` on `vpc/*` as well as on the child
types, it would let a child be created in any VPC as long as the tags were requested. The rewritten
comment says this.

**Liveness check: AuthorizeSecurityGroupIngress/Egress on `security-group-rule`.**
- The reference says: "Policies using the security-group-rule resource-level permission are only
  enforced when the API request includes TagSpecifications".
- `AWS::EC2::SecurityGroupIngress` and `SecurityGroupEgress` are not taggable (registry schemas, live run
  4 table), so CloudFormation sends no TagSpecifications for them. The `security-group-rule` resource is
  then not evaluated, and `NetworkChangeTagged` covers the `security-group` side through the group's demo
  tag.
- The inline egress rule CDK puts on a SecurityGroup goes the same way.
- That statement is unchanged by this split. I widened nothing. If a handler did send rule tags, the call
  would be denied and the run would fail closed, which would be a new live finding.
- **Other liveness assumptions** (the run will show them): the VPC carries the demo tag before its
  subnets, route tables and security groups are created. That holds because CreateVpc puts the tags in
  its TagSpecifications (`tagOnCreate`), and CloudFormation creates children only after their parent.

### sec-02 (low, test only): the CreateTags check had a hole
**Problem.** `R26` checked `NetworkCreate`'s actions with `/^ec2:Create/`, so `ec2:CreateTags` added to
that statement would have passed unnoticed.

**Fix** (`bootstrapStack.test.ts`):
- The old line is gone (its statement no longer exists).
- New test `sec-02`: every execution-policy statement that grants `ec2:CreateTags` (wildcards included)
  must condition it either on `ec2:CreateAction` together with `aws:RequestTag/project`, or on
  `aws:ResourceTag/project`.
- New test `sec-01` pins the split:
  - no child create on `*`;
  - on `vpc/*`, the only statement is `NetworkCreateInDemoVpc`, with the resource tag;
  - on the child types, the only statement is `NetworkCreateChildTagged`, with the request tag;
  - CreateVpc and CreateInternetGateway appear only in `NetworkCreateTagged`, with the request tag and
    never on `*`.
- I didn't add the optional Deny statement, as asked.

**Proof, from `vitest run src/bootstrapStack.test.ts -t "sec-0"`:**
- Against the old statement (HEAD's `bootstrapStack.ts` put back temporarily):
  "× sec-01: a subnet, route table or security group is created only in a VPC carrying the demo tag …",
  "AssertionError: NetworkCreate: expected [ '*' ] to not include '*'", "Tests 1 failed | 1 passed | 32
  skipped (34)".
- Against the new split: "Tests 2 passed | 32 skipped (34)".
- sec-02 passed against the old code too, because the old code had no extra CreateTags. Its proof is
  the breakages T1-T3 below, run with `-t "sec-02"` only, all red:
  - T1: CreateTags added to NetworkPrefixLists;
  - T2: CreateTags added to NetworkCreateTagged, which has a request tag but no CreateAction;
  - T3: `ec2:Create*` added.

**Breakages, full suite, one at a time; all 8 red:**
- S1: child creates on `*`. Red: sec-01, the on-`*` condition test and the union.
- S2: the VPC side on the request tag instead of the resource tag. Red: sec-01 and the union.
- S3: a child without the request tag. Red: sec-01 and the union.
- S4: CreateVpc without the request tag. Red: sec-01 and the union.
- S5: `vpc/*` added to the child statement, which merges request-tag and VPC. Red: sec-01 and the union.
- T1-T3: red, as above. In the full suite they also break the allow-list, R26 and the no-`*` action
  test.

### Other updates
- The allow-list test (R27) and the on-`*` condition test now list the four new statements.
- `demoTagging.test.ts` takes the network creates from the two RequestTag statements.
- The pre-split fixture `cfnExecutionStatements.json` replaces `NetworkCreate` with the four synthesised
  statements, copied from `cdk.out` after I checked them by hand.

### Policy sizes (worst case, minified, limit 6,144)
network 1,731 → **2,729** (7 statements); compute 2,367, data 1,926, cdn 1,103 and iam 1,309 are
unchanged.

### Bootstrap diff to expect (adds to the live-run-4 list above)
- `ascrum-cdk-cfn-execution-network`: `NetworkCreate` is removed. `NetworkCreateTagged`,
  `NetworkCreateInDemoVpc`, `NetworkCreateChildTagged` and `NetworkPrefixLists` are added. The policy is
  updated in place.

### Gates (this session; every AWS credential source at `/dev/null`, `AWS_PROFILE` unset; no AWS command)
- infra `pnpm verify` exit 0:
  - "All matched files use Prettier code style!";
  - typecheck clean;
  - "Test Files 12 passed (12)", "Tests 157 passed (157)";
  - "Successfully synthesized to …/infra/cdk.out".
- web `pnpm verify` (`STUB_PORT=4101 PREVIEW_PORT=5273 PAGES_PORT=5274`, Postgres on 55461) exit 0: "Tests 443 passed (443)" (unit), "Tests 87 passed (87)" (integration), "42 passed" (e2e).

## 2026-11-25, live run 5 (worker): Elastic Load Balancing's own EC2 call was refused

### What happened
Run 45714777383 got 35 of the AscrumDemo stack's 46 resources in, then failed at the load balancer:
"User: arn:aws:sts::***:assumed-role/ascrum-cfn-exec/AWSCloudFormation is not authorized to perform:
ec2:GetSecurityGroupsForVpc (Service: ElasticLoadBalancingV2, Status Code: 403)". The RDS instance was
cancelled as a side effect. Rollback, destroy and the leftovers check passed. The #82 network
permissions held: the VPC, IGW, subnets, route tables, routes, security groups and their rules all
reached CREATE_COMPLETE.

### Root cause, with sources
- Elastic Load Balancing calls `ec2:GetSecurityGroupsForVpc` with the caller's credentials while it
  creates the load balancer. The caller here is CloudFormation's execution role.
- The `AWS::ElasticLoadBalancingV2::LoadBalancer` registry schema does **not** list it. Its create
  handler lists `elasticloadbalancing:CreateLoadBalancer`, `DescribeLoadBalancers`,
  `ModifyLoadBalancerAttributes`, `ModifyCapacityReservation`, `AddTags`, `SetSecurityGroups` and
  `ec2:DescribeIpamPools`. The ELB page of the Service Authorization Reference (SAR) gives no dependent
  action for CreateLoadBalancer either.
- The source that does name it is the AWS managed policy `ElasticLoadBalancingFullAccess` (v10, AWS
  managed policy reference). Its EC2 statement lists `ec2:GetSecurityGroupsForVpc` and
  `ec2:ValidateSecurityGroupQuotasForInterface`, beside Describe calls we already grant through
  `ec2:Describe*`.
- **My mistake in #82:** the coverage table for live run 4 compared our statements with the schemas'
  handler permissions only. Schemas list the handler's own calls, not the calls a service then makes
  as the caller, so that table could not have predicted this failure. This round adds a second source:
  the managed FullAccess policies.

### Fix (Task 1)
- New statement `LoadBalancerEc2Reads` in `ascrum-cdk-cfn-execution-network`. It grants
  `ec2:GetSecurityGroupsForVpc` and `ec2:ValidateSecurityGroupQuotasForInterface` on `vpc/*` and
  `security-group/*` in our account and region. Conditions: `aws:RequestedRegion` and
  `aws:ResourceTag/project = ascrum-migration`.
- SAR (EC2, and the service reference JSON) for both actions:
  - GetSecurityGroupsForVpc: resource `vpc*`, keys `aws:ResourceTag/${TagKey}`,
    `ec2:ResourceTag/${TagKey}`, `ec2:Tenancy`, `ec2:VpcID`; action key `ec2:Region`; access level Read.
  - ValidateSecurityGroupQuotasForInterface: resource `security-group*`, keys
    `aws:ResourceTag/${TagKey}`, `ec2:ResourceTag/${TagKey}`, `ec2:SecurityGroupID`, `ec2:Vpc`; action
    key `ec2:Region`; access level Read.
  - So both scope to the demo tag. Neither needs `*`.
- ValidateSecurityGroupQuotasForInterface is added without a live failure behind it. ELB names it in
  the same managed-policy statement, and it is a tag-scoped read. Granting it now saves a run if ELB
  calls it next (SetSecurityGroups is in the create handler).

### Tests
- New: "live run 5: the EC2 reads Elastic Load Balancing makes while creating the load balancer are
  allowed, on the demo-tagged VPC and security groups only". Exactly one statement grants each action;
  resources and conditions are pinned.
- R27 allow-list: the new sid. R26 lists it among the EC2 non-reads, because its `isRead` pattern
  (`Describe|Get|List`) does not recognise `Validate…`. It passes R26's region and resource-tag rules.
  The pre-split fixture `cfnExecutionStatements.json` gains the synthesised statement.
- **Red without the grant:** with the statement removed (scratch script, file restored after):
  "AssertionError: ec2:GetSecurityGroupsForVpc: expected [] to deeply equal [ 'LoadBalancerEc2Reads' ]",
  "Tests 1 failed | 34 skipped (35)". **Green with it:** "Tests 1 passed | 34 skipped (35)".

### Look-ahead (Task 2): the 11 types the run never reached
Two sources per type:
- (S) the registry schema's create, read and delete handler permissions, compared with our statements
  by script;
- (M) the AWS managed FullAccess policy for the service (ELB, ECS, RDS, CloudFront, CloudWatch Logs,
  Secrets Manager): its cross-service actions that we do not grant.

The template has no custom resources. `AWS::CDK::Metadata` is written by the CLI.

| Resource type | Handler | Action not granted | Source | Added? |
|---|---|---|---|---|
| ElasticLoadBalancingV2::LoadBalancer | (service-side, create) | ec2:GetSecurityGroupsForVpc | M + live run 5 | **Yes**: `LoadBalancerEc2Reads`, `vpc/*`, demo tag, region |
| ElasticLoadBalancingV2::LoadBalancer | (service-side, create) | ec2:ValidateSecurityGroupQuotasForInterface | M | **Yes**: same statement, `security-group/*`, demo tag, region |
| ElasticLoadBalancingV2::LoadBalancer | create | elasticloadbalancing:ModifyCapacityReservation | S | No: only with `MinimumLoadBalancerCapacity`, which we do not set |
| ElasticLoadBalancingV2::LoadBalancer | (service-side) | ec2:GetCoipPoolUsage | M | No: Outposts customer-owned IPs |
| ElasticLoadBalancingV2::LoadBalancer | (service-side) | arc-zonal-shift:ListManagedResources, ListZonalShifts | M | No: zonal shift is a console feature; not set |
| ElasticLoadBalancingV2::Listener / ListenerRule | create | cognito-idp:DescribeUserPoolClient | S + M | No: only for `authenticate-cognito` actions; ours forward and fixed-response |
| ElasticLoadBalancingV2::TargetGroup | create | elasticloadbalancing:RegisterTargets | S | No: only with `Targets`; ECS registers tasks with its service-linked role. TargetGroup reached CREATE_COMPLETE in run 5 |
| ECS::Cluster, ::TaskDefinition, ::Service | create/read/delete | none | S | n/a |
| ECS (all) | (service-side) | application-autoscaling, codedeploy, servicediscovery, events, route53, autoscaling, cloudwatch alarms | M | No: auto scaling, blue/green, Service Connect, EC2 capacity; none in the template |
| Logs::LogGroup | create | logs:Get/PutDataProtectionPolicy, CreateLogDelivery, PutResourcePolicy, PutIndexPolicy, PutBearerTokenAuthentication, firehose:TagDeliveryStream | S | No: only with `DataProtectionPolicy`, `ResourcePolicyDocument`, field indexes or delivery; not set. LogGroup reached CREATE_COMPLETE in run 5 |
| RDS::DBInstance | create | rds:AddRoleToDBInstance, CreateDBInstanceReadReplica, RestoreDBInstanceFromDBSnapshot, RestoreDBInstanceToPointInTime, StartDBInstanceAutomatedBackupsReplication, iam:ListRoles | S | No: associated roles, replicas, restores and cross-region backups; none set |
| RDS::DBInstance | (service-side) | ec2:GetCoipPoolUsage, outposts:GetOutpostInstanceTypes, sns, cloudwatch, devops-guru | M | No: Outposts and console features |
| RDS::DBInstance | create (ManageMasterUserPassword) | kms:DescribeKey, secretsmanager:CreateSecret, secretsmanager:TagResource | RDS User Guide, "Permissions required for Secrets Manager integration" | Already granted (`DatabaseManagedSecret`, `ManagedKeysThroughRdsAndSecretsManager`). **Residual risk:** the KMS grant is conditioned on `kms:ViaService`; if RDS's DescribeKey on `aws/secretsmanager` doesn't arrive through RDS or Secrets Manager, the run fails here. Not changed: no evidence, and a wider KMS grant would be a loosening |
| SecretsManager (managed secret) | (service-side) | lambda, cloudformation, kms:ListKeys/ListAliases, tag:GetResources, redshift, docdb | M | No: console and rotation-Lambda features; RDS rotates its managed secret itself |
| CloudFront::Distribution | create | cloudfront:CreateConnectionGroup, GetConnectionGroup, GetVpcOrigin | S | No: multi-tenant connection groups and VPC origins; not used |
| CloudFront::Distribution | create | cloudfront:CreateDistributionWithTags | S | No IAM action of that name: the SAR authorises the API as CreateDistribution plus TagResource, both granted |
| CloudFront (all) | (service-side) | acm, iam:ListServerCertificates, wafv2, kinesis, shield, ec2:GetIpamPoolCidrs, pricingplanmanager | M | No: custom certificates, WAF, real-time logs, Anycast IPs, flat-rate plans; we use the default certificate |
| CloudFront::OriginAccessControl | create/read/delete | none | S | n/a; reached CREATE_COMPLETE in run 5 |
| S3::BucketPolicy | create/read/delete | none | S | n/a |
| IAM::Policy | create/delete | iam:Get/Put/DeleteUserPolicy, iam:Get/Put/DeleteGroupPolicy | S | No: ours attaches to a role only; the role calls are granted |

**Limit of this look-ahead:** the managed policies are the broadest public list of a service's
side calls, but AWS doesn't promise they are complete. A service can still call something neither
source names; if so, the next run will show it.

### Policy sizes (worst case, minified, limit 6,144)
network 2,729 → **3,113** (8 statements); compute 2,367, data 1,926, cdn 1,103, iam 1,309, deploy role
3,036 and boundary 872 are unchanged.

### Bootstrap diff to expect
- `ascrum-cdk-cfn-execution-network` (AWS::IAM::ManagedPolicy): one statement added,
  `LoadBalancerEc2Reads`. It allows `ec2:GetSecurityGroupsForVpc` and
  `ec2:ValidateSecurityGroupQuotasForInterface` on `arn:${Partition}:ec2:${Region}:${Account}:vpc/*` and
  `…:security-group/*`, where `aws:RequestedRegion` equals the region and `aws:ResourceTag/project`
  equals `ascrum-migration`. The policy is updated in place.
- No other policy, role, trust policy or boundary changes.

### Gates (this session; every AWS credential source at `/dev/null`, `AWS_PROFILE` unset; no AWS command)
- infra `pnpm verify` exit 0:
  - "All matched files use Prettier code style!";
  - typecheck clean;
  - "Test Files 12 passed (12)", "Tests 158 passed (158)";
  - "Successfully synthesized to …/infra/cdk.out".

## 2026-11-25, live run 6 (worker): leftover false positives; blocked on Q-p5-infra-12

- Run 45725657601: the deploy, the HTTPS smoke test and the destroy all passed. AC-AWS-04
  (`leftovers.ts`) then failed on an ECS service and an ECS task that the Resource Groups Tagging API
  still listed after deletion. The owner confirmed that the service is `INACTIVE` and the task is
  `STOPPED`, so both are false positives.
- Planned fix: classify services through `DescribeServices` (`INACTIVE` = gone) and tasks through
  `DescribeTasks` (`STOPPED` or reported MISSING = gone), batched by cluster. Every other state, and
  every failed or refused describe, stays a LEFTOVER.
- Permission check, step 3 of the brief: the destroy job runs as `ascrum-github-deploy`. Its
  `ReadOnlyChecks` grants `ecs:DescribeServices` but **not** `ecs:DescribeTasks`. The `ecs:Describe*`
  in the `ReadOnly` statement belongs to the CloudFormation execution role.
- **Blocked**, as the brief says: no edit to the deploy role, no script change, no PR. I wrote
  **Q-p5-infra-12** with the exact statement and its SAR scoping. The statement covers `task/ascrum-demo/*`
  plus the `ecs:cluster` key, in our account and region. The inline policy grows from 3,036 to 3,299
  characters worst case. I measured that with a temporary edit and reverted it with `git checkout`;
  `git status` was clean afterwards.
- Gates: none run. Only the questions file and this worklog changed. gitleaks on the staged question:
  "no leaks found".

## 2026-11-26, live run 6, round 2 (worker): Q-p5-infra-12 answered (b); the leftover check asks ECS

The owner answered Q-p5-infra-12 with **(b)**, recorded under the question (commit 72a44dd).

### Deploy role (`ascrum-github-deploy`)
- `ecs:DescribeServices` is removed from `ReadOnlyChecks`, which stays on `*` for its other reads.
- New `LeftoverEcsServices`: `ecs:DescribeServices` on `service/ascrum-demo/*`.
- New `LeftoverEcsTasks`: `ecs:DescribeTasks` on `task/ascrum-demo/*`.
- Both carry the condition `ArnEquals ecs:cluster = …:cluster/ascrum-demo`, in our account and region.
- SAR check (Amazon ECS page, and the service reference JSON): DescribeServices takes resource `service*`
  and DescribeTasks takes `task*`. Both list `aws:ResourceTag/${TagKey}`, `ecs:cluster` and
  `ecs:ResourceTag/${TagKey}`. So (b) is possible as asked; no fallback to (a).
- Nothing else depended on DescribeServices on `*`. The only `describe-services` call in `infra/scripts`
  and `.github/workflows` is the new one in `leftovers.ts`. `destroy.ts` uses CloudFormation only.

### `leftovers.ts`
- ECS services and tasks the tagging index still lists are described in batches per cluster and kind:
  - `describe-services --cluster <arn> --services …`, 10 at most (the API limit);
  - `describe-tasks --cluster <arn> --tasks …`, 100 at most.
- **Gone:** a service whose `status` is `INACTIVE`; a task whose `lastStatus` is `STOPPED`, or one the
  answer lists as a failure with reason `MISSING`.
- **LEFTOVER:** everything else. That includes ACTIVE and DRAINING services, a service reported MISSING,
  and tasks in any other state. It also includes an ARN the answer doesn't mention, and every call that
  fails (refused, cluster not found, or throttled past the CLI's own retries).
- An answer only clears the ARNs that were asked about.
- Sources, cited in the code comment:
  - Amazon ECS API Reference, DescribeServices: up to 10 services; Service `status` is ACTIVE, DRAINING
    or INACTIVE.
  - API Reference, DescribeTasks: up to 100 tasks; "stopped tasks appear in the returned results for at
    least one hour".
  - Developer Guide, "Amazon ECS task lifecycle": PROVISIONING, PENDING, ACTIVATING, RUNNING,
    DEACTIVATING, STOPPING, DEPROVISIONING, STOPPED, plus DELETED, "a transition state when a task stops".
- `isGhost` is unchanged, so task definitions, clusters and secrets are classified as before. It is not
  called for services or tasks.
- **Changed existing test (S14):** it listed an ECS service among the "leftovers without asking". A
  service is now asked about, so I took it out of that list and added services and tasks to the test
  name. The remaining billable types (RDS, EC2, ELB, CloudFront, S3, logs, ECR) are still never asked,
  and the test still checks that.

### Residual risks (not changed; following the brief)
- **A service reported MISSING stays a LEFTOVER.** If the tagging index outlives ECS's INACTIVE record,
  the check fails until the index drops the service. That costs a re-run, never a missed resource.
- **A task in the DELETED transition state is a LEFTOVER** until it shows STOPPED or MISSING. The six
  attempts, 30 s apart, give it time.
- **If ECS answers ClusterNotFoundException** after the cluster is gone, the tasks stay LEFTOVER (fail
  closed). The API reference says tagged tasks of a deleted cluster are still returned.

### Tests and evidence
- New tests in `leftovers.test.ts`, block "live run 6":
  - INACTIVE service plus STOPPED and MISSING tasks are gone, asked in exactly one call per kind;
  - 12 services are asked in batches of 10 and 2;
  - ACTIVE, DRAINING and MISSING services are leftovers;
  - RUNNING, PENDING, PROVISIONING, DEPROVISIONING and STOPPING tasks are leftovers;
  - a throttled DescribeServices and a refused DescribeTasks both fail the check;
  - an answer about another ARN doesn't clear the one asked;
  - task definitions and clusters are still described one by one.
- `bootstrapStack.test.ts`: the allow-list test has the two new sids, and `ReadOnlyChecks` no longer has
  DescribeServices. New pin test: "live run 6 / Q-p5-infra-12: ecs:DescribeServices and
  ecs:DescribeTasks only on the ascrum-demo cluster, never on "*"". It checks that exactly one statement
  grants each action (wildcards matched), the resource, and the condition.
- **Red against the pre-fix script and role** (HEAD versions of `leftovers.ts` and `bootstrapStack.ts`):
  "Tests 4 failed | 11 passed | 47 skipped". The failures were:
  - the INACTIVE/STOPPED/MISSING test;
  - the batching test;
  - the deploy-role allow-list;
  - the new pin test.
- The ACTIVE/DRAINING/RUNNING/PENDING and error tests already passed against the old script, which
  reported every service and task as a leftover. They guard against an over-eager fix.
- **Green with the fix:** 26 of 26 leftover tests pass.
- **Breakages, one at a time, all red** (scratch script, files restored after):
  - B1, DRAINING counted as gone: red on the DRAINING test.
  - B2, a failed describe counted as gone: red on the refused/throttled test.
  - B3, MISSING not recognised: red on the INACTIVE/STOPPED/MISSING test.
  - B4, any answered ARN accepted: red on the "another ARN" test.
  - B5, every task except PENDING counted as gone: red on RUNNING, PROVISIONING, DEPROVISIONING and
    STOPPING.
  - B6, no batch limit: red on the batching test.
  - B7, DescribeServices back on `*`: red on the allow-list and the pin test.
  - B8, DescribeTasks on `*`: red on the allow-list and the pin test.
  - B9, the `ecs:cluster` condition dropped: red on the pin test.

### Policy sizes (worst case, minified)
- Deploy role's inline policy: 3,036 → **3,548** characters (12 → 14 statements). The limit is 10,240
  for all of a role's inline policies together.
- Execution parts are unchanged: network 3,113, compute 2,367, data 1,926, cdn 1,103, iam 1,309.
- Boundary 872.

### Bootstrap diff to expect (owner redeploys the bootstrap before the next live run)
- `ascrum-github-deploy`'s default policy (AWS::IAM::Policy `DeployRoleDefaultPolicy…`), updated in
  place:
  - `ReadOnlyChecks` loses `ecs:DescribeServices`;
  - `LeftoverEcsServices` is added;
  - `LeftoverEcsTasks` is added.
- No managed policy, trust policy, boundary or execution-role change.

### Gates (this session; every AWS credential source at `/dev/null`, `AWS_PROFILE` unset; no AWS command)
- infra `pnpm verify` exit 0:
  - "All matched files use Prettier code style!";
  - typecheck clean;
  - "Test Files 12 passed (12)", "Tests 172 passed (172)";
  - "Successfully synthesized to …/infra/cdk.out".
