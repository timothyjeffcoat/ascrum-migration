// AC-AWS-04: delete everything a deploy run created. Used by both workflows: the `destroy` job of
// deploy-demo.yml (always, also after a failure or a cancel) and destroy-demo.yml on its own.
//
//   AWS_REGION=… node infra/scripts/destroy.ts
//
// It works from whatever state a run left behind, without synthesising the app (so without the deploy's
// context): a stack that does not exist is skipped, one that is still being created or rolled back is
// waited for, an update in progress is cancelled, and the web bucket is emptied before its stack is
// deleted. CloudFormation deletes each stack with the stack's own execution role. A second run finds
// nothing and changes nothing.
import { DEMO_STACKS_DESTROY_ORDER } from '../src/names.ts'
import { awsCli, awsJson, realSleep, redact, stackStatus, type Aws, type Sleep } from './aws.ts'

export type DestroyOptions = {
  aws: Aws
  region: string
  sleep?: Sleep
  log?: (line: string) => void
  /** How long to wait for one stack to settle or be deleted (CloudFront and RDS take minutes). */
  timeoutMs?: number
  pollMs?: number
}

async function emptyBuckets(aws: Aws, stack: string, region: string, log: (line: string) => void) {
  const body = (await awsJson(aws, [
    'cloudformation',
    'list-stack-resources',
    '--stack-name',
    stack,
    '--region',
    region,
  ])) as { StackResourceSummaries?: { ResourceType?: string; PhysicalResourceId?: string; ResourceStatus?: string }[] }
  for (const resource of body?.StackResourceSummaries ?? []) {
    if (resource.ResourceType !== 'AWS::S3::Bucket' || !resource.PhysicalResourceId) continue
    if (resource.ResourceStatus === 'DELETE_COMPLETE') continue
    const bucket = resource.PhysicalResourceId
    const result = await aws(['s3', 'rm', `s3://${bucket}`, '--recursive', '--only-show-errors', '--region', region])
    if (result.code !== 0 && !/NoSuchBucket/.test(result.stderr)) {
      throw new Error(`emptying s3://${redact(bucket)} failed: ${result.stderr.trim()}`)
    }
    log(`  emptied bucket ${redact(bucket)}`)
  }
}

async function failureEvents(aws: Aws, stack: string, region: string): Promise<string[]> {
  const result = await aws(['cloudformation', 'describe-stack-events', '--stack-name', stack, '--region', region])
  if (result.code !== 0) return []
  const body = JSON.parse(result.stdout) as {
    StackEvents?: { LogicalResourceId?: string; ResourceStatus?: string; ResourceStatusReason?: string }[]
  }
  return (body.StackEvents ?? [])
    .filter((event) => event.ResourceStatus?.endsWith('_FAILED'))
    .slice(0, 10)
    .map((event) => `    ${event.LogicalResourceId}: ${event.ResourceStatus} ${event.ResourceStatusReason ?? ''}`)
}

export async function destroyDemo(options: DestroyOptions): Promise<{ deleted: string[]; absent: string[] }> {
  const { aws, region, sleep = realSleep, log = console.log, timeoutMs = 75 * 60_000, pollMs = 15_000 } = options
  const deleted: string[] = []
  const absent: string[] = []

  /** Polls until the stack is gone or in a state that is not *_IN_PROGRESS; returns that state. */
  const settle = async (stack: string, until: (status: string | null) => boolean): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs
    for (let waited = 0; ; waited += pollMs) {
      const status = await stackStatus(aws, stack, region)
      if (until(status)) return status
      if (waited >= timeoutMs || Date.now() > deadline) {
        throw new Error(`${stack} still ${status} after ${Math.round(timeoutMs / 60_000)} min`)
      }
      await sleep(pollMs)
    }
  }
  const notInProgress = (status: string | null) =>
    status === null || !status.endsWith('_IN_PROGRESS') || status === 'REVIEW_IN_PROGRESS'

  for (const stack of DEMO_STACKS_DESTROY_ORDER) {
    let status = await stackStatus(aws, stack, region)
    if (status === null) {
      log(`${stack}: does not exist, nothing to delete`)
      absent.push(stack)
      continue
    }
    log(`${stack}: ${status}`)
    if (status === 'UPDATE_IN_PROGRESS') {
      log(`  cancelling the update in progress`)
      await aws(['cloudformation', 'cancel-update-stack', '--stack-name', stack, '--region', region])
    }
    if (!notInProgress(status) && status !== 'DELETE_IN_PROGRESS') {
      status = await settle(stack, notInProgress)
      log(`  settled: ${status ?? 'gone'}`)
    }

    for (let attempt = 1; status !== null; attempt++) {
      await emptyBuckets(aws, stack, region, log)
      if (status !== 'DELETE_IN_PROGRESS') {
        await awsJson(aws, ['cloudformation', 'delete-stack', '--stack-name', stack, '--region', region])
        log(`  delete-stack (attempt ${attempt})`)
      }
      status = await settle(stack, (s) => s === null || s === 'DELETE_FAILED')
      if (status === null) break
      log(`  ${status}:`)
      for (const line of await failureEvents(aws, stack, region)) log(line)
      if (attempt >= 2) throw new Error(`${stack} could not be deleted (${status}); see the events above`)
    }
    log(`  deleted`)
    deleted.push(stack)
  }
  return { deleted, absent }
}

if (import.meta.main) {
  const region = process.env.AWS_REGION
  if (!region) {
    console.error('AWS_REGION is required')
    process.exit(2)
  }
  const { deleted, absent } = await destroyDemo({ aws: awsCli, region })
  console.log(`deleted: ${deleted.join(', ') || 'none'}; already absent: ${absent.join(', ') || 'none'}`)
}
