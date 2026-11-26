# Questions raised by cluster p5-infra (Phase 5, wave C)

Ids are `Q-p5-infra-<n>` (spec §8, `conversion-spec.md` §8.5). None blocks the code: each is implemented
as recommended, and each can be changed without touching the app or the wire contract. Several decide
what the owner sets up once (infra/README.md), so they matter before the first live run.

**Q-p5-infra-1. How tightly the deploy role trusts GitHub (OIDC subject).**
Context: spec §11 has the deploy role assumable only by this repo's workflows; the brief asks for it to
be scoped to `migration` and to the deploy and destroy workflows. GitHub's default OIDC subject for a job
with an environment is `repo:<owner>/<repo>:environment:<name>`: it names neither the branch nor the
workflow file. Then only the environment's branch rule (set in GitHub, not in the repo) stops a workflow
on another branch, for example one an agent pushes in a PR, from assuming the role.
Options: (a) customise the repository's subject to `repo`, `context`, `job_workflow_ref` (one owner
`gh api` call) and trust exactly the two subjects
`repo:<owner>/<repo>:environment:aws-demo:job_workflow_ref:<owner>/<repo>/.github/workflows/{deploy,destroy}-demo.yml@refs/heads/migration`;
(b) keep the default subject and trust `repo:<owner>/<repo>:environment:aws-demo`, relying on the
environment's branch rule; (c) the default subject without an environment (`...:ref:refs/heads/migration`),
which any workflow file on `migration` matches.
*Recommended and implemented: (a)*, with the environment's branch rule as well (two locks, one of them
in reviewed code). If the subject is not customised, the role cannot be assumed at all (fails closed). A
risk to check on the first run: the customisation applies to every OIDC token of the repository; the
Pages deploy (`actions/deploy-pages`) also uses one. I found no report that it depends on the subject,
but I could not test it; if Pages breaks, (b) is the fallback and is a one-line change in
`infra/src/bootstrapStack.ts` (`trustedSubjects`).

**Q-p5-infra-2. CloudFront → load balancer is plain HTTP.**
Context: spec §3.6 puts the API behind a load balancer and CloudFront in front. The repo has no domain,
so there is no certificate the ALB could present for HTTPS from CloudFront (its `*.elb.amazonaws.com`
name has none). The viewer → CloudFront leg is HTTPS (AC-AWS-03); the CloudFront → ALB leg is HTTP over
the network between CloudFront's edge and the region.
Options: (a) accept for a demo that lives for minutes and only holds the public seed data: the ALB
admits CloudFront's origin-facing prefix list only and forwards only requests carrying a per-run random
header (else 403); (b) a CloudFront VPC origin with an internal ALB (the traffic stays inside AWS);
creating and deleting VPC origins takes many minutes, and their network interfaces can hold up the VPC's
deletion, which puts AC-AWS-04 at risk; (c) the owner registers a domain: ACM certificates for
CloudFront and the ALB, HTTPS on both legs.
*Recommended and implemented: (a)* for now. (c) is the right answer for anything with real users;
(b) if the reviewer or the owner wants the hop off the public network without a domain.

**Q-p5-infra-3. TLS to RDS without verifying the server's certificate.**
Context: RDS for PostgreSQL 18 requires TLS (`rds.force_ssl=1`). `pg` verifies certificates against
Node's CA list, which does not include Amazon's RDS CAs, and the API image has no RDS CA bundle
(p5-containers' note for wave C). `docker/**` and `api/**` are not my paths.
Options: (a) `sslmode=no-verify` in the `DATABASE_URL` the container builds (encrypted, not
authenticated; the database is reachable only from the API's security group inside the VPC); (b) add
Amazon's RDS CA bundle to the API image (`docker/api.Dockerfile`, a pinned and checksummed download) and
use `sslmode=verify-full&sslrootcert=…`; (c) turn `rds.force_ssl` off (no).
*Recommended: (b), as a follow-up for the owner of `docker/**`; implemented: (a)* until then. The switch
is one parameter in `API_START_SCRIPT` (`infra/src/demoStack.ts`).

**Q-p5-infra-4. What the budget alarm watches.**
Context: AC-AWS-06 asks for an alarm before "the monthly cost of `demo`" passes the owner's limit. A
budget can filter on the `project` tag, but only after the owner activates it as a cost allocation tag in
Billing (up to 24 h, and only for costs after that); before then a tag-filtered budget shows $0 and would
never fire.
Options: (a) the whole account's monthly cost (fires early rather than never; includes anything else in
the account); (b) filtered on `project=ascrum-migration`; (c) both, two budgets.
*Recommended and implemented: (a).* (b) or (c) once the tag is active, if the account has other spend.
Notifications: actual cost above 80 % of the limit, and forecast above 100 %.

**Q-p5-infra-5. "All required checks passed on that commit" (AC-AWS-01).**
Context: the deploy's gate reads the required checks from `migration`'s branch protection (11 today),
then the check runs on the commit. `CodeQL` (app 57789, code scanning) runs on pull requests only, so a
squash-merge commit on `migration` never has it.
Options: (a) for a required check missing on the commit, accept it from the head commit of the pull
request that was merged as exactly this commit (`merge_commit_sha`, base `migration`), where branch
protection required it before merging; every other check must be on the commit itself; (b) leave
`CodeQL` out of the deploy gate; (c) also run code scanning on pushes to `migration`.
*Recommended and implemented: (a).* Only `success` counts (not `skipped` or `neutral`), every run of a
name must pass (CI's `build` and the Pages `build` share a name), and the commit must be the head of
`migration`. Tests: `infra/scripts/requiredChecks.test.ts`.
*Corrected 2026-11-24 (DEV-p5-infra-02):* the first implementation applied the fallback to **every**
missing check, not only to `CodeQL`, so a commit with no push runs at all (a dispatch before the runs
exist, or a `[skip ci]` squash message) passed on the PR head's results. The fallback is now limited to
an explicit list, `PR_ONLY_CHECKS` = `CodeQL` from app 57789 (name **and** app id must match); every other
required check missing on the commit refuses the deploy. Named tests: the reviewer's probe (no run on the
commit, all green on the PR head: refused), a `[skip ci]`-style commit, one push check missing, and a
`CodeQL` from another app.

**Q-p5-infra-6. Choices the spec leaves open (region, names, sizes).**
- Region: the owner's choice, as the `aws-demo` environment variable `AWS_REGION`; nothing in the code
  depends on it. The role ARN goes in the environment secret `AWS_DEPLOY_ROLE_ARN` (it contains the
  account id; a variable would print it in the public logs).
- Database: PostgreSQL major 18 (Q-p5-2; RDS picks its default minor), `db.t4g.micro`, 20 GB gp3, single
  AZ, no backups. API: one Fargate task, 0.25 vCPU / 512 MiB, x86_64 (the runner builds the image natively;
  Graviton would need an emulated build).
- How the smoke test signs in: the seed's public demo credentials (`web/stub/seed.ts`, in the README),
  as user `dev1`. The deployed API runs in production mode and seeds its new database once, so the seed
  users exist; for the few minutes the demo is up, anyone with the URL could sign in with them.
*Recommended and implemented as listed.*

**Q-p5-infra-7. Every CI job now installs the CDK packages.**
Context: `pnpm install` in `web/` (the shared `setup-web` action) installs the whole workspace, and the
owner's ownership note adds `infra` to it. `aws-cdk-lib`, `aws-cdk` and `@aws-cdk/asset-awscli-v1` are
about 67 MB to download, and the action's cache key is `web/pnpm-lock.yaml` only, so a change to
`infra/pnpm-lock.yaml` alone does not refresh the cache.
Options: (a) accept and measure it on the first CI runs; (b) `setup-web` installs with
`--filter ./web --filter ./api` and only the `infra` job installs `infra`, and the cache key includes
`infra/pnpm-lock.yaml` (not my path: `.github/actions/setup-web`); (c) take `infra` out of the workspace
and install it on its own.
*Recommended: (a) now, (b) if the measured cost is more than a few seconds per job.*

**Q-p5-infra-8. Making the new checks required.**
Context: the `infra` CI job (lint, typecheck, unit tests, synth of `infra/`) is new. The deploy gate reads
the required checks from branch protection, so once `infra` is required, a deploy also needs it green.
Options: (a) the reviewer or owner adds `infra` to `migration`'s required checks after merge (as with
`integration` and `e2e-compose`); (b) leave it optional.
*Recommended: (a).*

**Q-p5-infra-9. How the demo stacks are deployed without CDK's bootstrap roles (DEV-p5-infra-01).**
Context: the reviewer found that the deploy role's `sts:AssumeRole` on CDK's `cdk-ascrum-deploy-role`
reached every stack in the account (CDK's bootstrap template grants CloudFormation writes, deletes and
`UpdateTerminationProtection` on `*`), and the owner's account is shared. The owner asked for a code fix.
Options: (a) the deploy role makes the CloudFormation calls itself, scoped to `AscrumDemo*` stacks, and
hands CloudFormation an execution role the bootstrap stack creates; no `cdk bootstrap` at all; (b) keep
`cdk bootstrap` and put a permissions boundary on CDK's roles; (c) a dedicated account only.
*Implemented: (a), plus (c) as the README's recommendation.* The demo stacks use a small synthesizer
(`infra/src/synthesizer.ts`) whose manifest names no role to assume and the execution role
`ascrum-cfn-exec`; the CLI sends each template inline (all are well under 51,200 bytes, pinned). The
deploy role may only `CreateChangeSet` on `AscrumDemo*` with `cloudformation:RoleArn` = that role, pass
that role only to CloudFormation, and is explicitly denied termination protection, stack policies,
refactors and anything on `AscrumBootstrap`/`CDKToolkit*`. (b) was rejected: CDK's roles would still
exist, broader than needed, and their boundary would be one more thing to keep in step with CDK's
template versions. Unverifiable offline, so watch the first live run: whether CloudFormation authorises
`DescribeChangeSet`/`ExecuteChangeSet`/`DeleteChangeSet` against the stack ARN (granted) or a change-set
ARN (not granted; the run would fail closed with AccessDenied naming it), and whether each EC2 create
passes its tags in the create call (needed for the tag-on-create rule; worklog, round 3).

**Q-p5-infra-10. The tag key that ties an RDS-managed secret to its DB instance (DEV-p5-infra-10).**
Context: the reviewer asked to limit the demo roles' boundary to the demo DB's secret with
`aws:ResourceTag/aws:rds:primaryDBInstanceArn`. The Service Authorization Reference confirms that
`secretsmanager:GetSecretValue` and `DescribeSecret` accept `aws:ResourceTag/${TagKey}`, and the RDS
guide gives the instance ARN format (`arn:<partition>:rds:<region>:<account>:db:<identifier>`). I found
no AWS page that names the tag key RDS puts on its managed secrets; the only sources are third-party
repositories and an emulator. Options: (a) use the key as asked (fails closed: if RDS used another key,
the API task cannot read its secret and the first live run fails at task start, naming the denied call);
(b) drop the condition (every RDS-managed secret in the region readable, the gap DEV-10 names);
(c) the owner reads the tags of any RDS-managed secret once (`describe-secret`, no secret value) and
confirms the key. *Implemented: (a), with (c) as the check for the first live run.* No answer needed to
proceed; it is recorded so the first run's owner knows what a "secret: AccessDenied" at task start means.

**Q-p5-infra-11. The immutable OIDC subject: its `job_workflow_ref` part, and no name-form fallback.**
Context: in the first live setup GitHub's read-back of the repository's subject customisation showed
`use_immutable_subject: true` with the owner and repository ids in `sub_claim_prefix`, and a PUT with
`false` was ignored. The deploy role trusted the name-only subject, so it could not be assumed (fail
closed). GitHub documents that the ids are always in the `repo` segment, also with `include_claim_keys`,
and cannot be removed. It does not document an immutable example with `job_workflow_ref`; its examples
of that claim use names (`owner/repo/.github/workflows/<file>@refs/heads/<branch>`), and the claims table
calls it "the ref path to the reusable workflow".
Options for `job_workflow_ref`: (a) the name path, as documented for the claim; (b) an id form, which
GitHub documents nowhere, so there is no exact string to trust; (c) both via a wildcard (refused: no
wildcards in the trust). *Implemented: (a).* If the first deploy run fails to assume the role while
`sub_claim_prefix` equals the bootstrap stack's `OidcSubjectPrefix` output, (a) is wrong: the owner
reads the actual `sub` (for example by decoding a token's payload in a throwaway workflow, or from the
CloudTrail `AssumeRoleWithWebIdentity` event, if it records it) and the trust is changed to that exact
string.
Name-form fallback: not kept. Recommendation and reasoning: trusting the name-only subjects as well would
reopen exactly what immutable subjects close (a renamed owner or repository name taken over by someone
else, with the same environment and workflow paths, could assume the role); GitHub says the ids cannot be
removed and renames and transfers move a repository to the immutable form, so the fallback could only
ever help an attacker. If GitHub ever emitted the name form again, the role fails closed and the fix is a
bootstrap redeploy. Owner: confirm, or ask for the fallback explicitly.

**Q-p5-infra-12. Live run 6: the leftover check needs `ecs:DescribeTasks` on the deploy role.** *(answered)*
Context: run 45725657601 deployed, passed the smoke test and destroyed cleanly. Then AC-AWS-04
(`infra/scripts/leftovers.ts`) failed on two false positives that the tagging index still listed: the
ECS service (`INACTIVE`, per the owner) and its task (`STOPPED`). The fix is to ask ECS about both, the
way the script already asks about clusters and task definitions. The destroy job runs as
`ascrum-github-deploy`. Its `ReadOnlyChecks` statement already grants `ecs:DescribeServices` (on `*`)
but not `ecs:DescribeTasks`. Only the CloudFormation execution role has `ecs:Describe*`, and the script
does not run as that role. Without the grant, every task lookup is refused, and the check must then
fail (a refused describe never counts as gone). The deploy role is the owner's call, so I stopped
before editing it.

Service Authorization Reference, Amazon ECS: `DescribeTasks` (Read) takes resource type `task*`
(`arn:${Partition}:ecs:${Region}:${Account}:task/${ClusterName}/${TaskId}`), with condition keys
`aws:ResourceTag/${TagKey}`, `ecs:cluster` and `ecs:ResourceTag/${TagKey}`. `DescribeServices` is the
same on `service*`.

Proposed statement, added to the deploy role's default policy in `bootstrapStack.ts`:
```ts
new iam.PolicyStatement({
  // AC-AWS-04: the leftover check asks ECS whether a task the tagging index still lists is STOPPED.
  sid: 'LeftoverEcsTasks',
  actions: ['ecs:DescribeTasks'],
  resources: [arn('ecs', `task/${NAMES.cluster}/*`)],
  conditions: { ArnEquals: { 'ecs:cluster': arn('ecs', `cluster/${NAMES.cluster}`) } },
}),
```
That is: tasks of the `ascrum-demo` cluster only, in our account and the deploy region. `arn()` binds
both.
- I scoped by cluster, not by the `project` tag. A tag condition could deny a describe of a task whose
  tags have gone, and the check would fail closed for no real reason.
- The ARN and the `ecs:cluster` key say the same thing. I kept both on purpose, as belt and braces.

Size: the deploy role's inline policy goes from 3,036 to **3,299** characters worst case (12 → 13
statements). I measured this with a temporary local edit, reverted before anything was committed. The
limit for a role's inline policies is 10,240 characters in total.

Options:
- (a) Add the statement above. This needs a bootstrap redeploy by the owner before the next live run.
- (b) As (a), and also move `ecs:DescribeServices` off `*` into the same cluster-scoped form
  (`service/ascrum-demo/*`). That tightens the role. The size grows by about the same amount again.
- (c) No new permission: treat a task as gone when its cluster is INACTIVE. **Not recommended.** That
  infers the task's state instead of reading it, and it is the kind of shortcut by type the brief rules
  out.

Recommendation: (a), or (b) if the owner wants the tightening in the same redeploy. The script and test
changes (services: `INACTIVE` = gone; tasks: `STOPPED` or reported MISSING = gone; everything else,
and every failed or refused describe, = LEFTOVER) don't depend on the answer except for this grant. I'll
write them, with the grant, once this is answered.

Owner answer (2026-11-26): (b).

**Q-p5-infra-13. May the leftover check count an ECS service that ECS reports as MISSING as gone?** *(answered)*
Context (review of #84, DEV-p5-infra-35):
- The #84 leftover check counts a service as gone only when it is `INACTIVE`. A service in
  DescribeServices' `failures` with reason `MISSING` stays a LEFTOVER.
- The DeleteService reference says an INACTIVE service may be cleaned up and purged after a while; ECS
  then no longer knows it.
- Run 7 recreates the `ascrum-demo` cluster. Run 6's service ARN carries a random suffix, so if the
  tagging index still lists it during run 7's check, ECS can only answer MISSING for it. Run 7 would
  then fail on a run-6 ghost.

Options:
- (a) Keep MISSING as a leftover. That is safe, but it can fail a clean run until the tagging index
  drops the entry.
- (b) Count a service that `failures` names with reason exactly `MISSING` as gone. Only that ARN, only
  if it was asked about, and only that reason. Any other failure reason, a failed call, or an ARN the
  answer doesn't mention stays a LEFTOVER.

Recommendation: (b).
- An ECS service itself is not billed; only its tasks are. Tasks are still checked one by one: STOPPED
  or MISSING is gone, anything else is a leftover.
- A MISSING service therefore cannot hide running cost.

Owner answer (2026-11-26): count a MISSING service as gone
