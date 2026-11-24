// AC-AWS-04, the final step of every deploy and destroy run: list what is still tagged
// `project=ascrum-migration` and fail if anything remains apart from the one-time bootstrap (tagged
// `ascrum-env=bootstrap`: the OIDC provider, the deploy role, the policies, the budget, and the CDK
// bootstrap stack when the owner tagged it as infra/README.md says).
//
//   AWS_REGION=… node infra/scripts/leftovers.ts
//
// Two regions are listed: the deploy region and us-east-1, where CloudFront's resources are indexed.
// The tagging index lags behind deletions, and keeps some deleted resources for good: an ECS task
// definition is only deregistered (INACTIVE), an ECS cluster turns INACTIVE, a Secrets Manager secret
// may wait out its recovery window. Those are asked about directly, and none of them costs anything.
// Anything else still listed is retried a few times before the check fails.
import { DEMO_STACKS_DESTROY_ORDER, TAG } from '../src/names.ts'
import { awsCli, realSleep, redact, stackStatus, type Aws, type Sleep } from './aws.ts'

type Mapping = { ResourceARN: string; Tags?: { Key: string; Value: string }[] }

export type LeftoverReport = { ok: boolean; kept: string[]; gone: string[]; remaining: string[]; stacks: string[] }

async function tagged(aws: Aws, region: string): Promise<Mapping[]> {
  const result = await aws([
    'resourcegroupstaggingapi',
    'get-resources',
    '--region',
    region,
    '--tag-filters',
    `Key=${TAG.project.key},Values=${TAG.project.value}`,
  ])
  if (result.code !== 0) throw new Error(`get-resources in ${region} failed: ${result.stderr.trim()}`)
  return (JSON.parse(result.stdout) as { ResourceTagMappingList?: Mapping[] }).ResourceTagMappingList ?? []
}

function regionOf(arn: string): string {
  return arn.split(':')[3] || 'us-east-1'
}

/** True when the service says the resource is gone or only a record of something deleted. */
export async function isGhost(aws: Aws, arn: string): Promise<boolean> {
  const [, , service, region = '', , resource = ''] = arn.split(':')
  const where = ['--region', region || 'us-east-1']
  if (service === 'ecs' && resource.startsWith('task-definition/')) {
    const result = await aws(['ecs', 'describe-task-definition', '--task-definition', arn, ...where])
    if (result.code !== 0) return /not found|does not exist|Unable to describe/i.test(result.stderr)
    const status = (JSON.parse(result.stdout) as { taskDefinition?: { status?: string } }).taskDefinition?.status
    return status === 'INACTIVE' || status === 'DELETE_IN_PROGRESS'
  }
  if (service === 'ecs' && resource.startsWith('cluster/')) {
    const result = await aws(['ecs', 'describe-clusters', '--clusters', arn, ...where])
    if (result.code !== 0) return false
    const clusters = (JSON.parse(result.stdout) as { clusters?: { status?: string }[] }).clusters ?? []
    return clusters.every((cluster) => cluster.status === 'INACTIVE')
  }
  if (service === 'secretsmanager') {
    const result = await aws(['secretsmanager', 'describe-secret', '--secret-id', arn, ...where])
    if (result.code !== 0) return /ResourceNotFoundException/.test(result.stderr)
    return Boolean((JSON.parse(result.stdout) as { DeletedDate?: unknown }).DeletedDate)
  }
  return false
}

export async function findLeftovers(options: {
  aws: Aws
  region: string
  sleep?: Sleep
  attempts?: number
  pollMs?: number
}): Promise<LeftoverReport> {
  const { aws, region, sleep = realSleep, attempts = 6, pollMs = 30_000 } = options
  const stacks: string[] = []
  for (const stack of DEMO_STACKS_DESTROY_ORDER) {
    const status = await stackStatus(aws, stack, region)
    if (status !== null) stacks.push(`${stack} (${status})`)
  }

  let report: LeftoverReport = { ok: false, kept: [], gone: [], remaining: [], stacks }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const kept: string[] = []
    const gone: string[] = []
    const remaining: string[] = []
    const seen = new Set<string>()
    for (const where of [...new Set([region, 'us-east-1'])]) {
      for (const mapping of await tagged(aws, where)) {
        if (seen.has(mapping.ResourceARN)) continue
        seen.add(mapping.ResourceARN)
        const env = mapping.Tags?.find((t) => t.Key === TAG.envKey)?.Value
        if (env === TAG.bootstrap) kept.push(mapping.ResourceARN)
        else if (await isGhost(aws, mapping.ResourceARN)) gone.push(mapping.ResourceARN)
        else remaining.push(mapping.ResourceARN)
      }
    }
    report = { ok: stacks.length === 0 && remaining.length === 0, kept, gone, remaining, stacks }
    if (report.ok || stacks.length > 0 || attempt === attempts) break
    await sleep(pollMs) // the tagging index may still list something just deleted
  }
  return report
}

export function formatReport(report: LeftoverReport): string[] {
  const lines = [
    `Demo stacks still present: ${report.stacks.length === 0 ? 'none' : report.stacks.join(', ')}`,
    `Kept (one-time bootstrap, ascrum-env=${TAG.bootstrap}): ${report.kept.length}`,
    ...report.kept.map((arn) => `  kept     ${redact(arn)}`),
    `Deleted, still in the tagging index (inactive or pending deletion): ${report.gone.length}`,
    ...report.gone.map((arn) => `  gone     ${redact(arn)}`),
    `Remaining: ${report.remaining.length}`,
    ...report.remaining.map((arn) => `  LEFTOVER ${redact(arn)} (${regionOf(arn)})`),
    report.ok ? 'OK: nothing from the demo remains.' : 'FAILED: demo resources remain (AC-AWS-04).',
  ]
  return lines
}

if (import.meta.main) {
  const region = process.env.AWS_REGION
  if (!region) {
    console.error('AWS_REGION is required')
    process.exit(2)
  }
  const report = await findLeftovers({ aws: awsCli, region })
  for (const line of formatReport(report)) console.log(line)
  process.exit(report.ok ? 0 : 1)
}
