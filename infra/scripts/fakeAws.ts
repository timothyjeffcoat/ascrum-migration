// A small stand-in for the AWS CLI in the script tests: CloudFormation stacks that move through their
// states one poll at a time, an S3 bucket with objects, and the tagging index. No network, no credentials.
import type { Aws, AwsResult } from './aws.ts'

export type FakeStack = {
  /** States the stack reports on successive describe-stacks calls; the last one repeats. */
  states: string[]
  /** What delete-stack leads to, one state per later poll (default: DELETE_IN_PROGRESS, then gone). */
  onDelete?: string[][]
  bucket?: string
}

export type FakeWorld = {
  stacks: Record<string, FakeStack>
  bucketObjects?: Record<string, number>
  /** Tagging index per region: ARN → tags. */
  tagged?: Record<string, Record<string, Record<string, string>>>
  taskDefinitionStatus?: Record<string, string>
  clusterStatus?: Record<string, string>
  /** ECS service status by ARN (default ACTIVE); 'MISSING' or 'failure:<reason>' answers with a failure. */
  serviceStatus?: Record<string, string>
  /** ECS task lastStatus by ARN (default RUNNING); 'MISSING' or 'failure:<reason>' answers with a failure. */
  taskStatus?: Record<string, string>
  /** stderr of a failing ECS describe call, by command (describe-services, describe-tasks). */
  ecsError?: Record<string, string>
  secretDeleted?: Record<string, boolean>
  /** stderr of a failing describe-stacks per stack (an AccessDenied, an expired token, …). */
  describeStacksError?: Record<string, string>
  /** stderr of a failing `s3 rm` per bucket. */
  s3RmError?: Record<string, string>
  /** stderr of a failing get-resources per region. */
  taggingError?: Record<string, string>
}

const ok = (body: unknown): AwsResult => ({
  code: 0,
  stdout: body === undefined ? '' : JSON.stringify(body),
  stderr: '',
})
const fail = (stderr: string): AwsResult => ({ code: 254, stdout: '', stderr })

export function fakeAws(world: FakeWorld): { aws: Aws; calls: string[][] } {
  const calls: string[][] = []
  const deletes: Record<string, number> = {}
  const arg = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? ''

  const aws: Aws = async (args) => {
    calls.push(args)
    const [service, command] = args
    if (service === 'cloudformation') {
      const name = arg(args, '--stack-name')
      const denied = world.describeStacksError?.[name]
      if (command === 'describe-stacks' && denied !== undefined) return fail(denied)
      const stack = world.stacks[name]
      const gone = () =>
        fail(
          `An error occurred (ValidationError) when calling the ${command} operation: Stack with id ${name} does not exist`,
        )
      if (!stack || stack.states.length === 0) return gone()
      const current = stack.states[0] ?? ''
      switch (command) {
        case 'describe-stacks': {
          if (stack.states.length > 1) stack.states.shift()
          if (current === 'GONE') return gone()
          return ok({ Stacks: [{ StackName: name, StackStatus: current }] })
        }
        case 'list-stack-resources':
          if (current === 'GONE') return gone()
          return ok({
            StackResourceSummaries: stack.bucket
              ? [
                  {
                    ResourceType: 'AWS::S3::Bucket',
                    PhysicalResourceId: stack.bucket,
                    ResourceStatus: 'CREATE_COMPLETE',
                  },
                ]
              : [],
          })
        case 'delete-stack': {
          if (current === 'GONE') return ok(undefined) // CloudFormation: deleting a missing stack succeeds
          if (stack.bucket && (world.bucketObjects?.[stack.bucket] ?? 0) > 0) {
            stack.states = ['DELETE_IN_PROGRESS', 'DELETE_FAILED']
            return ok(undefined)
          }
          const n = (deletes[name] = (deletes[name] ?? 0) + 1)
          stack.states = stack.onDelete?.[n - 1] ?? ['DELETE_IN_PROGRESS', 'GONE']
          return ok(undefined)
        }
        case 'cancel-update-stack':
          stack.states = ['UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE']
          return ok(undefined)
        case 'describe-stack-events':
          return ok({
            StackEvents: [
              {
                LogicalResourceId: 'WebBucket',
                ResourceStatus: 'DELETE_FAILED',
                ResourceStatusReason: 'The bucket you tried to delete is not empty',
              },
            ],
          })
      }
    }
    if (service === 's3' && command === 'rm') {
      const bucket = (args[2] ?? '').replace('s3://', '')
      const error = world.s3RmError?.[bucket]
      if (error !== undefined) return fail(error)
      if (world.bucketObjects && bucket in world.bucketObjects) world.bucketObjects[bucket] = 0
      else return fail('An error occurred (NoSuchBucket)')
      return ok(undefined)
    }
    if (service === 'resourcegroupstaggingapi') {
      const error = world.taggingError?.[arg(args, '--region')]
      if (error !== undefined) return fail(error)
      const index = world.tagged?.[arg(args, '--region')] ?? {}
      return ok({
        ResourceTagMappingList: Object.entries(index).map(([arn, tags]) => ({
          ResourceARN: arn,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        })),
      })
    }
    if (service === 'ecs' && command === 'describe-task-definition') {
      return ok({
        taskDefinition: { status: world.taskDefinitionStatus?.[arg(args, '--task-definition')] ?? 'ACTIVE' },
      })
    }
    if (service === 'ecs' && command === 'describe-clusters') {
      return ok({ clusters: [{ status: world.clusterStatus?.[arg(args, '--clusters')] ?? 'ACTIVE' }] })
    }
    if (service === 'ecs' && (command === 'describe-services' || command === 'describe-tasks')) {
      const error = world.ecsError?.[command]
      if (error !== undefined) return fail(error)
      const listFlag = command === 'describe-services' ? '--services' : '--tasks'
      const start = args.indexOf(listFlag) + 1
      const end = args.findIndex((a, i) => i >= start && a.startsWith('--'))
      const asked = args.slice(start, end === -1 ? undefined : end)
      const states = (command === 'describe-services' ? world.serviceStatus : world.taskStatus) ?? {}
      const fallback = command === 'describe-services' ? 'ACTIVE' : 'RUNNING'
      const reason = (arn: string) => {
        const state = states[arn]
        return state === 'MISSING' ? 'MISSING' : state?.startsWith('failure:') ? state.slice('failure:'.length) : null
      }
      const found = asked.filter((arn) => reason(arn) === null)
      const failures = asked.filter((arn) => reason(arn) !== null).map((arn) => ({ arn, reason: reason(arn) }))
      return ok(
        command === 'describe-services'
          ? { services: found.map((arn) => ({ serviceArn: arn, status: states[arn] ?? fallback })), failures }
          : { tasks: found.map((arn) => ({ taskArn: arn, lastStatus: states[arn] ?? fallback })), failures },
      )
    }
    if (service === 'secretsmanager' && command === 'describe-secret') {
      return ok(world.secretDeleted?.[arg(args, '--secret-id')] ? { DeletedDate: '2026-11-24T00:00:00Z' } : {})
    }
    throw new Error(`fake aws: unexpected call ${args.join(' ')}`)
  }
  return { aws, calls }
}
