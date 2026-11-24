# infra/: the AWS `demo` (Phase 5, wave C)

A CDK app (TypeScript, Q-p5-5) and the scripts the two workflows run. Spec: `spec/phase5-spec.md` §3.6,
§5.4 (AC-AWS-01..07), §11. Nothing stays running (rev 2): each run of **Deploy demo (AWS)** creates
`demo`, smoke-tests it over HTTPS, keeps the evidence and deletes everything it created.

```
viewer ─HTTPS─▶ CloudFront ─┬─ /login /logout /current-user /databases/* /__stub/* ─HTTP─▶ ALB ─▶ ECS Fargate (API) ─TLS─▶ RDS PostgreSQL 18
                            └─ everything else ─OAC─▶ S3 (vite build)
```

| Stack                | Deployed by                                           | Contents                                                                                        |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AscrumBootstrap`    | the owner, **once**, with the owner's own credentials | GitHub OIDC provider, deploy role, CloudFormation execution policy, role boundary, budget alarm |
| `AscrumDemoRegistry` | each deploy run (deleted by the same run)             | ECR repository `ascrum-demo-api`, scan on push                                                  |
| `AscrumDemo`         | each deploy run (deleted by the same run)             | VPC (no NAT), RDS, ECS cluster and service, ALB, S3 bucket, CloudFront                          |

## Commands (no AWS needed)

From `infra/` (dependencies come with `pnpm install` in `web/`, which installs the whole workspace):

| Gate      | Command                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------ |
| lint      | `pnpm lint` (web's ESLint rules and Prettier)                                                          |
| typecheck | `pnpm typecheck`                                                                                       |
| unit      | `pnpm test` (CDK assertions on the stacks; the workflow scripts against a fake AWS CLI and GitHub API) |
| synth     | `pnpm synth` (placeholders for the deploy-time values; no account, no credentials, no lookups)         |
| all four  | `pnpm verify`                                                                                          |

The scripts start the dev tools through their own entry files (`node node_modules/eslint/bin/eslint.js`,
…), not through `node_modules/.bin`: those tools are `link:` entries into `web/node_modules`, and a
workspace install may link `infra/` before `web/` is populated, in which case pnpm creates no `.bin`
shims for them (it happened in CI on the first push).

The CI job `infra` runs the same four with every AWS credential source pointed at `/dev/null`.

`pnpm smoke` is the post-deploy test (`smoke/`); it needs a deployed `demo` (`SMOKE_BASE_URL`,
`SMOKE_ALB_URL`) and only the deploy workflow runs it.

## One-time setup (the owner)

Agents never run these (spec §11). Values in `<angle brackets>` are yours and are never committed:
account id, region, budget limit, e-mail.

You need the AWS CLI v2 signed in to your account, Node 24, pnpm (from `web/`: `corepack enable`,
`pnpm install`) and `gh` signed in to GitHub.

### 1. Deploy the bootstrap stack

It needs no CDK bootstrap (it has no assets and is deployed with your CLI credentials).

```sh
cd infra
export AWS_REGION=<region>
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
pnpm exec cdk deploy AscrumBootstrap -c githubRepository="$REPO" \
  --parameters BudgetLimitUsd=<monthly limit in USD> \
  --parameters BudgetEmail=<e-mail for the alarm>
```

If the account already has a GitHub OIDC provider (an account can have only one per URL), add
`-c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.

The stack has termination protection. Its outputs: `DeployRoleArn`, `CfnExecutionPolicyArn`,
`RoleBoundaryArn`.

### 2. CDK bootstrap, with this repo's qualifier and the execution policy

`--cloudformation-execution-policies` replaces CDK's default (AdministratorAccess) with the policy from
step 1, so a deploy can only create what the demo stacks need. The qualifier keeps these roles apart from
any other CDK app in the account. The tags let the final leftover check recognise the bootstrap as
something that stays.

```sh
POLICY_ARN=$(aws cloudformation describe-stacks --stack-name AscrumBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='CfnExecutionPolicyArn'].OutputValue" --output text)
pnpm exec cdk bootstrap "aws://<account>/$AWS_REGION" -c githubRepository="$REPO" \
  --qualifier ascrum --toolkit-stack-name CDKToolkit-ascrum \
  --cloudformation-execution-policies "$POLICY_ARN" \
  --tags project=ascrum-migration --tags ascrum-env=bootstrap
```

### 3. GitHub: OIDC subject, environment, variable and secret

The deploy role trusts tokens whose subject names the repository, the `aws-demo` environment **and** the
workflow file on `migration` (Q-p5-infra-1). GitHub only puts the workflow in the subject once the
repository asks for it:

```sh
gh api -X PUT "repos/$REPO/actions/oidc/customization/sub" --input - <<'EOF'
{ "use_default": false, "include_claim_keys": ["repo", "context", "job_workflow_ref"] }
EOF
```

The environment, limited to `migration` (add yourself as a required reviewer if you want to approve
each run):

```sh
gh api -X PUT "repos/$REPO/environments/aws-demo" --input - <<'EOF'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
EOF
gh api -X POST "repos/$REPO/environments/aws-demo/deployment-branch-policies" -f name=migration -f type=branch
```

Its variable and secret (the role ARN contains the account id, so it is a secret and stays masked in the
public logs):

| Name                  | Kind (environment `aws-demo`) | Value                                        |
| --------------------- | ----------------------------- | -------------------------------------------- |
| `AWS_REGION`          | variable                      | `<region>`                                   |
| `AWS_DEPLOY_ROLE_ARN` | secret                        | the bootstrap stack's `DeployRoleArn` output |

```sh
gh variable set AWS_REGION --env aws-demo --body "$AWS_REGION"
aws cloudformation describe-stacks --stack-name AscrumBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text \
  | gh secret set AWS_DEPLOY_ROLE_ARN --env aws-demo
```

### 4. Run it

Actions → **Deploy demo (AWS)** → Run workflow → branch `migration`. It refuses unless every required
check passed on the head of `migration`. The artifact `demo-evidence-<run>-<attempt>` holds the smoke
output, the screenshot, the image scan, the destroy and leftover reports, who ran it, and every step's
timing.

Actions → **Destroy demo (AWS)** deletes the demo stacks on its own (a second run is a no-op) and runs
the same leftover check.

For the measured cost (spec §7), activate the cost allocation tag `project` in Billing; the budget itself
watches the whole account (Q-p5-infra-4).

### Removing everything for good

Run **Destroy demo (AWS)**, then with your own credentials: delete `CDKToolkit-ascrum` (empty its
`cdk-ascrum-assets-…` bucket first), turn off termination protection on `AscrumBootstrap` and delete it,
and reset the OIDC subject (`{"use_default": true}`).

## What a deploy run may do

| Who                                                              | Can                                                                                                                                                                                                                                                                    | Cannot                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| deploy role (`ascrum-github-deploy`, OIDC only)                  | assume `cdk-ascrum-deploy-role` and `-file-publishing-role`; push to and read scans of `ascrum-demo-api`; write the web bucket; describe and delete `AscrumDemo*` stacks; read-only checks (prefix list, tagged resources, ECS and secret status, the API's log group) | any IAM write; any other stack, bucket or repository; read a secret's value                  |
| CloudFormation, for the demo stacks (`ascrum-cdk-cfn-execution`) | create and delete exactly the resource types the demo uses (named actions, this region); roles named `AscrumDemo*` only, and only with the boundary below                                                                                                              | `*` actions; IAM users, groups, keys or policies; remove a boundary; read any secret's value |
| the demo's own roles (boundary `ascrum-demo-role-boundary`)      | pull the API image, write the API's logs, read RDS-managed secrets                                                                                                                                                                                                     | anything else, whatever a template grants                                                    |

Unit tests pin each of these (`src/bootstrapStack.test.ts`).

## Design notes and open questions

- **No NAT gateway, no VPC endpoints.** The API task has a public address in a public subnet, so it can
  reach ECR, Secrets Manager and CloudWatch Logs through the internet gateway; its security group admits
  only the load balancer. The database sits in isolated subnets (no route out at all) and admits only
  the API (AC-AWS-05).
- **CloudFront → ALB.** The ALB admits CloudFront's origin-facing prefix list only, and forwards only
  requests carrying a per-run random header; anything else gets 403. The hop is HTTP: without a domain
  there is no certificate for the ALB (Q-p5-infra-2). `TRUST_PROXY_HOPS=2` (CloudFront, then the ALB).
- **Database.** PostgreSQL 18 (Q-p5-2), `db.t4g.micro`, single AZ, encrypted, no backups or final
  snapshot (it lives for minutes). RDS generates the password and keeps it in a secret it owns; the
  container builds `DATABASE_URL` from it at start. TLS is on but the certificate is not verified, because
  the image has no RDS CA bundle (Q-p5-infra-3).
- **Image scan.** ECR basic scanning on push; the run stops on any HIGH or CRITICAL finding before the
  service exists (spec §6 image-scan). Only the API image goes to AWS; the web build goes to S3.
- **Destroy** deletes the stacks with CloudFormation directly (no synth), so it works after a partial or
  cancelled deploy; it empties the web bucket first. Nothing in the demo stacks is retained, snapshotted
  or deletion-protected, and nothing depends on a Lambda-backed custom resource.
- **Leftover check.** Lists everything tagged `project=ascrum-migration` in the region and in us-east-1
  (CloudFront); only `ascrum-env=bootstrap` may remain. Deregistered task definitions, inactive clusters
  and secrets pending deletion stay in the tagging index but cost nothing; the check asks the service.
- Questions: `spec/questions/p5-infra.md`. Log: `spec/worklogs/p5-infra.md`.
