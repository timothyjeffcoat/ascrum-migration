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
