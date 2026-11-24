// Every name the stacks, the workflows and the scripts share. The deploy role's permissions (bootstrap
// stack) are scoped to these names, so they live in one place: renaming a resource here renames it
// everywhere, and a resource outside these names is out of the role's reach.
//
// Nothing account-specific is written here (CLAUDE.md, spec §11): account ids and the region come from
// the AWS environment at deploy time, as CloudFormation pseudo parameters.

/** The GitHub repository whose workflows may deploy. Passed at bootstrap time, never hard-coded. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** The GitHub environment the deploy and destroy jobs run in (its OIDC `sub` names it). */
export const GITHUB_ENVIRONMENT = 'aws-demo'

/** The only branch that may deploy (AC-AWS-01). */
export const DEPLOY_BRANCH = 'migration'

/** The two workflow files that may assume the deploy role (Q-p5-infra-1). */
export const DEPLOY_WORKFLOWS = ['.github/workflows/deploy-demo.yml', '.github/workflows/destroy-demo.yml'] as const

export const STACK = {
  /** Deployed once by the owner (spec §11); never by CI, never destroyed by the workflows. */
  bootstrap: 'AscrumBootstrap',
  /** The ECR repository the API image is pushed to (deployed first, so the image exists for the service). */
  registry: 'AscrumDemoRegistry',
  /** Everything else: network, database, API service, web bucket, CloudFront. */
  demo: 'AscrumDemo',
} as const

/** The demo stacks, in the order destroy deletes them (the reverse of deploy). */
export const DEMO_STACKS_DESTROY_ORDER = [STACK.demo, STACK.registry] as const

/** Prefix of every demo stack: the deploy role may only describe and delete stacks named like this. */
export const DEMO_STACK_PREFIX = 'AscrumDemo'

export const TAG = {
  /** On every resource of every stack: what the final leftover check lists. */
  project: { key: 'project', value: 'ascrum-migration' },
  /** `demo` or `bootstrap`. Only `bootstrap` may remain after a run (AC-AWS-04). */
  envKey: 'ascrum-env',
  demo: 'demo',
  bootstrap: 'bootstrap',
} as const

export const NAMES = {
  deployRole: 'ascrum-github-deploy',
  /** The role CloudFormation uses for the demo stacks (bootstrap stack; no `cdk bootstrap`). */
  cfnExecutionRole: 'ascrum-cfn-exec',
  /** Its managed policy: what CloudFormation may create, change and delete for the demo. */
  cfnExecutionPolicy: 'ascrum-cdk-cfn-execution',
  /** Permissions boundary on every role the demo stacks create. */
  roleBoundary: 'ascrum-demo-role-boundary',
  apiRepository: 'ascrum-demo-api',
  apiLogGroup: '/ascrum/demo/api',
  budget: 'ascrum-demo-monthly',
  // Fixed names for the demo's resources whose ARNs carry their name, so the execution policy can name
  // them instead of "*" (DEV-p5-infra-05). Each run creates them after the previous run deleted them.
  loadBalancer: 'ascrum-demo',
  targetGroup: 'ascrum-demo-api',
  cluster: 'ascrum-demo',
  taskFamily: 'ascrum-demo-api',
  dbInstance: 'ascrum-demo-db',
  dbSubnetGroup: 'ascrum-demo-db',
  spaFunction: 'ascrum-demo-spa-fallback',
} as const

/** Region-unique bucket name for the web build; the account id and region are filled in at deploy time. */
export function webBucketName(account: string, region: string): string {
  return `ascrum-demo-web-${account}-${region}`
}

/** The header CloudFront adds to API requests and the load balancer requires (demo stack). */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify'

/** The contract's paths that CloudFront sends to the API (spec §3.6, docker/web/default.conf.template). */
export const API_PATH_PATTERNS = ['/login', '/logout', '/current-user', '/databases/*', '/__stub/*'] as const
