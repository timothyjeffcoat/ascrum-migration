// AC-AWS-04, the final step of every deploy and destroy run: list what is still tagged
// `project=ascrum-migration` and fail if anything remains apart from the one-time bootstrap (tagged
// `ascrum-env=bootstrap`: the OIDC provider, the deploy role, the policies, the budget, and the CDK
// bootstrap stack when the owner tagged it as infra/README.md says).
//
//   AWS_REGION=… node infra/scripts/leftovers.ts
//
// Two regions are listed: the deploy region and us-east-1, where CloudFront's resources are indexed.
// The tagging index lags behind deletions, and keeps some deleted resources for good: an ECS task
// definition is only deregistered (INACTIVE), an ECS cluster turns INACTIVE, a deleted ECS service turns
// INACTIVE, a stopped ECS task stays STOPPED, a Secrets Manager secret may wait out its recovery window.
// Those are asked about directly, and none of them costs anything. Anything else still listed is retried a
// few times before the check fails.
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

// ECS services and tasks (live run 6: both were still in the tagging index after the destroy, as INACTIVE
// and STOPPED). They are described in batches per cluster: DescribeServices takes up to 10 services,
// DescribeTasks up to 100 tasks (Amazon ECS API Reference).
// - A service's status is ACTIVE, DRAINING or INACTIVE (API Reference, Service). INACTIVE is gone, and so
//   is a service the answer names in `failures` with reason MISSING: DeleteService says an INACTIVE service
//   may be cleaned up and purged, after which ECS no longer knows it (Q-p5-infra-13, owner answer). A
//   service is not billed; its tasks are, and they are checked one by one. DRAINING still runs tasks.
// - A task's lastStatus moves through PROVISIONING, PENDING, ACTIVATING, RUNNING, DEACTIVATING, STOPPING,
//   DEPROVISIONING to STOPPED (Developer Guide, "Amazon ECS task lifecycle"). Only STOPPED is gone, or a
//   task DescribeTasks reports as a MISSING failure (it keeps stopped tasks "for at least one hour").
// - Everything else is a leftover: any other state, a failure with any reason but MISSING, an ARN the
//   answer does not mention or mentions more than once, an answer that is not JSON, and every call that
//   fails (refused, cluster not found, throttled past the CLI's retries). A call that fails never counts
//   as gone, and an answer only clears ARNs its own call asked about.
const ECS_BATCH = { service: 10, task: 100 } as const
type EcsKind = keyof typeof ECS_BATCH

function ecsResource(arn: string): { kind: EcsKind; region: string; cluster: string } | null {
  const [, partition = 'aws', service, region = '', account = '', resource = ''] = arn.split(':')
  const [kind, ...rest] = resource.split('/')
  if (service !== 'ecs' || (kind !== 'service' && kind !== 'task') || rest.length === 0) return null
  // The old ARN form has no cluster part; such a resource is in the default cluster.
  const name = rest.length > 1 ? (rest[0] ?? 'default') : 'default'
  return { kind, region, cluster: `arn:${partition}:ecs:${region}:${account}:cluster/${name}` }
}

type EcsAnswer = {
  services?: { serviceArn?: string; status?: string }[]
  tasks?: { taskArn?: string; lastStatus?: string }[]
  failures?: { arn?: string; reason?: string }[]
}

/** The ECS services and tasks among `arns` that ECS says are deleted (INACTIVE) or stopped. */
export async function ecsGhosts(aws: Aws, arns: string[]): Promise<Set<string>> {
  const groups = new Map<string, { kind: EcsKind; region: string; cluster: string; arns: string[] }>()
  for (const arn of arns) {
    const parsed = ecsResource(arn)
    if (!parsed) continue
    const key = `${parsed.kind} ${parsed.cluster}`
    const group = groups.get(key) ?? { ...parsed, arns: [] }
    group.arns.push(arn)
    groups.set(key, group)
  }
  const gone = new Set<string>()
  for (const { kind, region, cluster, arns: all } of groups.values()) {
    for (let i = 0; i < all.length; i += ECS_BATCH[kind]) {
      const batch = all.slice(i, i + ECS_BATCH[kind])
      const result = await aws([
        'ecs',
        kind === 'service' ? 'describe-services' : 'describe-tasks',
        '--cluster',
        cluster,
        kind === 'service' ? '--services' : '--tasks',
        ...batch,
        '--region',
        region || 'us-east-1',
      ])
      if (result.code !== 0) continue // refused, throttled or failed: every ARN in the batch stays a leftover
      let answer: EcsAnswer
      try {
        answer = JSON.parse(result.stdout) as EcsAnswer
      } catch {
        continue
      }
      const asked = new Set(batch)
      // Every entry of the answer as [ARN, says gone]; an ARN mentioned twice (or as found and as a failure)
      // is a contradictory answer and stays a leftover.
      const entries: [string | undefined, boolean][] = [
        ...(kind === 'service'
          ? (answer.services ?? []).map((s): [string | undefined, boolean] => [s.serviceArn, s.status === 'INACTIVE'])
          : (answer.tasks ?? []).map((t): [string | undefined, boolean] => [t.taskArn, t.lastStatus === 'STOPPED'])),
        ...(answer.failures ?? []).map((f): [string | undefined, boolean] => [f.arn, f.reason === 'MISSING']),
      ]
      const mentions = new Map<string, number>()
      for (const [arn] of entries) if (arn !== undefined) mentions.set(arn, (mentions.get(arn) ?? 0) + 1)
      for (const [arn, saysGone] of entries) {
        if (saysGone && arn !== undefined && asked.has(arn) && mentions.get(arn) === 1) gone.add(arn)
      }
    }
  }
  return gone
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
    const candidates: string[] = []
    for (const where of [...new Set([region, 'us-east-1'])]) {
      for (const mapping of await tagged(aws, where)) {
        if (seen.has(mapping.ResourceARN)) continue
        seen.add(mapping.ResourceARN)
        const env = mapping.Tags?.find((t) => t.Key === TAG.envKey)?.Value
        if (env === TAG.bootstrap) kept.push(mapping.ResourceARN)
        else candidates.push(mapping.ResourceARN)
      }
    }
    const ecsGone = await ecsGhosts(aws, candidates)
    for (const arn of candidates) {
      if (ecsGone.has(arn) || (ecsResource(arn) === null && (await isGhost(aws, arn)))) gone.push(arn)
      else remaining.push(arn)
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
