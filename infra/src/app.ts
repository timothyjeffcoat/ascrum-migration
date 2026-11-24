// The CDK app: three stacks, their tags, synthesizers and the permissions boundary. bin/app.ts runs it
// with the context the CLI passes (`-c key=value`); the tests build it with their own context.
//
// Context keys:
//   githubRepository        `owner/repo` (bootstrap stack). Falls back to $GITHUB_REPOSITORY (set in CI).
//   existingOidcProviderArn the account's GitHub OIDC provider, if it already has one (bootstrap stack).
//   demoDeploy=true         a real deploy: the three values below are required, no placeholders.
//   imageTag                the API image tag in the registry (the commit SHA).
//   originSecret            per-run secret header between CloudFront and the load balancer.
//   cloudFrontPrefixListId  the region's CloudFront origin-facing managed prefix list.
//
// Without demoDeploy, the demo stack synthesises with placeholders, so `cdk synth` (CI, unit tests)
// needs no AWS account, no credentials and no lookups.
import { App, CliCredentialsStackSynthesizer, DefaultStackSynthesizer, Tags, type Stack } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { BootstrapStack } from './bootstrapStack.ts'
import { DemoStack } from './demoStack.ts'
import { CDK_QUALIFIER, NAMES, STACK, TAG } from './names.ts'
import { RegistryStack } from './registryStack.ts'

export const PLACEHOLDER = {
  imageTag: 'synth-only',
  originSecret: 'synthonlysynthonlysynthonlysynthonly',
  cloudFrontPrefixListId: 'pl-00000000',
} as const

type Context = (key: string) => unknown

function text(context: Context, key: string): string | undefined {
  const value = context(key)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new Error(`context ${key} must be a non-empty string`)
  return value
}

function demoValue(context: Context, key: keyof typeof PLACEHOLDER, deploy: boolean): string {
  const value = text(context, key)
  if (value !== undefined) return value
  if (deploy) throw new Error(`context ${key} is required with demoDeploy=true`)
  return PLACEHOLDER[key]
}

function tag(stack: Stack, env: string) {
  Tags.of(stack).add(TAG.project.key, TAG.project.value)
  Tags.of(stack).add(TAG.envKey, env)
}

export type AscrumStacks = { bootstrap: BootstrapStack; registry: RegistryStack; demo: DemoStack }

export function buildStacks(app: App, env: Record<string, string | undefined> = process.env): AscrumStacks {
  const context: Context = (key) => app.node.tryGetContext(key)
  const githubRepository = text(context, 'githubRepository') ?? env.GITHUB_REPOSITORY
  if (!githubRepository) {
    throw new Error('context githubRepository (owner/repo) is required, or $GITHUB_REPOSITORY (see infra/README.md)')
  }
  const deployFlag = context('demoDeploy')
  const deploy = deployFlag === true || deployFlag === 'true'

  const bootstrap = new BootstrapStack(app, STACK.bootstrap, {
    description: 'ascrum-migration: one-time bootstrap (GitHub OIDC, deploy role, budget). Deployed by the owner only.',
    synthesizer: new CliCredentialsStackSynthesizer(),
    githubRepository,
    existingOidcProviderArn: text(context, 'existingOidcProviderArn'),
    terminationProtection: true,
  })
  tag(bootstrap, TAG.bootstrap)

  const demoSynthesizer = () => new DefaultStackSynthesizer({ qualifier: CDK_QUALIFIER })
  const registry = new RegistryStack(app, STACK.registry, {
    description: 'ascrum-migration demo: API image repository (created and deleted by each deploy run)',
    synthesizer: demoSynthesizer(),
  })
  tag(registry, TAG.demo)

  const demo = new DemoStack(app, STACK.demo, {
    description: 'ascrum-migration demo: web, API, database (created and deleted by each deploy run)',
    synthesizer: demoSynthesizer(),
    imageTag: demoValue(context, 'imageTag', deploy),
    originSecret: demoValue(context, 'originSecret', deploy),
    cloudFrontPrefixListId: demoValue(context, 'cloudFrontPrefixListId', deploy),
  })
  tag(demo, TAG.demo)
  // Every role in the demo stacks gets the bootstrap stack's boundary; the CloudFormation execution
  // policy refuses to create a role without it.
  for (const stack of [registry, demo]) {
    iam.PermissionsBoundary.of(stack).apply(
      iam.ManagedPolicy.fromManagedPolicyName(stack, 'RoleBoundary', NAMES.roleBoundary),
    )
  }
  return { bootstrap, registry, demo }
}
