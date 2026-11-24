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
