// The live task definition record (live run 10's caveat): what is read, what is kept, and every mismatch
// that fails the step. The step itself, as the workflow runs it, is in entrypoints.test.ts.
import { describe, expect, it } from 'vitest'
import { synth } from '../src/testApp.ts'
import type { Aws, AwsResult } from './aws.ts'
import {
  ACCOUNT,
  liveAnswers,
  liveContainer,
  REGION,
  SERVICE_ARN,
  TAG,
  TASK_DEFINITION_ARN,
} from './fakeTaskDefinition.ts'
import { EXPECTED, evidenceText, liveTaskDefinition, problems, type LiveRecord } from './taskDefinition.ts'

type Answers = {
  resources?: unknown
  services?: unknown
  taskDefinition?: unknown
  /** stderr of a refused call, by command. */
  refused?: Record<string, string>
}

function fake(answers: Answers): { aws: Aws; calls: string[][] } {
  const calls: string[][] = []
  const ok = (body: unknown): AwsResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' })
  const aws: Aws = async (args) => {
    calls.push(args)
    const command = args[1] ?? ''
    const refused = answers.refused?.[command]
    if (refused !== undefined) return { code: 254, stdout: '', stderr: refused }
    if (command === 'list-stack-resources') return ok(answers.resources)
    if (command === 'describe-services') return ok(answers.services)
    if (command === 'describe-task-definition') return ok(answers.taskDefinition)
    throw new Error(`unexpected call ${args.join(' ')}`)
  }
  return { aws, calls }
}

const read = (answers: Answers = liveAnswers()) => liveTaskDefinition({ aws: fake(answers).aws, region: REGION })
const problemsFor = async (container: Record<string, unknown>, service: Record<string, unknown> = {}) =>
  problems(await read(liveAnswers(container, service)), TAG)

describe('live run 10: the task definition the service runs, in the evidence', () => {
  it('live run 10: asks the demo stack for its service, that service for its task definition, then AWS for its copy', async () => {
    const { aws, calls } = fake(liveAnswers())
    await liveTaskDefinition({ aws, region: REGION })
    expect(calls).toEqual([
      ['cloudformation', 'list-stack-resources', '--stack-name', 'AscrumDemo', '--region', REGION],
      // --cluster by name: the deploy role's DescribeServices is bound to the demo cluster (LeftoverEcsServices).
      ['ecs', 'describe-services', '--cluster', 'ascrum-demo', '--services', SERVICE_ARN, '--region', REGION],
      ['ecs', 'describe-task-definition', '--task-definition', TASK_DEFINITION_ARN, '--region', REGION],
    ])
  })

  it("live run 10: a matching copy passes and the record keeps AWS's linuxParameters, user, image and revision", async () => {
    const record = await read()
    expect(problems(record, TAG)).toEqual([])
    expect(record.taskDefinition).toEqual({
      arn: TASK_DEFINITION_ARN,
      family: 'ascrum-demo-api',
      revision: 7,
      status: 'ACTIVE',
    })
    expect(record.containers).toEqual(['api'])
    expect(record.container).toEqual({
      name: 'api',
      image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/ascrum-demo-api:${TAG}`,
      user: '1000:1000',
      readonlyRootFilesystem: true,
      linuxParameters: { capabilities: { add: [], drop: ['ALL'] }, devices: [], initProcessEnabled: true, tmpfs: [] },
    })
    expect(record.service?.deployments).toEqual([
      { status: 'PRIMARY', taskDefinition: TASK_DEFINITION_ARN, runningCount: 1, rolloutState: 'COMPLETED' },
    ])
  })

  it('spec §11: the record never holds the environment, the secrets (not even their ARNs) or the command, and its file has no account id', async () => {
    const text = evidenceText(await read())
    for (const never of ['environment', 'environment-value-never-kept', 'secrets', 'DB_PASSWORD', 'secretsmanager']) {
      expect(text).not.toContain(never)
    }
    expect(text).not.toContain('start-script-never-kept')
    expect(text).not.toMatch(/\b\d{12}\b/)
    expect(text).toContain('arn:aws:ecs:eu-west-1:***:task-definition/ascrum-demo-api:7')
  })
})

describe('live run 10: AWS’s copy must match, or the step fails (fail closed)', () => {
  const linux = (linuxParameters: unknown) => liveContainer({ linuxParameters })
  const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['no capability dropped', linux({ capabilities: { drop: [] }, initProcessEnabled: true }), {}, 'capabilities.drop'],
    ['one capability dropped', linux({ capabilities: { drop: ['NET_RAW'] }, initProcessEnabled: true }), {}, 'drop'],
    ['no capabilities at all', linux({ initProcessEnabled: true }), {}, 'capabilities.drop'],
    [
      'a capability added',
      linux({ capabilities: { add: ['NET_BIND_SERVICE'], drop: ['ALL'] }, initProcessEnabled: true }),
      {},
      'capabilities.add',
    ],
    ['init off', linux({ capabilities: { drop: ['ALL'] }, initProcessEnabled: false }), {}, 'initProcessEnabled'],
    ['init missing', linux({ capabilities: { drop: ['ALL'] } }), {}, 'initProcessEnabled'],
    ['no linuxParameters', liveContainer({ linuxParameters: undefined }), {}, 'capabilities.drop'],
    ['no user', liveContainer({ user: undefined }), {}, 'user is unset'],
    ['root', liveContainer({ user: '0' }), {}, 'user is 0'],
    ['uid only', liveContainer({ user: '1000' }), {}, 'user is 1000,'],
    ['a writable root filesystem', liveContainer({ readonlyRootFilesystem: false }), {}, 'read-only'],
    ['another image tag', liveContainer({ image: `x/ascrum-demo-api:${'0'.repeat(40)}` }), {}, 'image'],
    ['another repository', liveContainer({ image: `x/other:${TAG}` }), {}, 'image'],
    ['the API container renamed', liveContainer({ name: 'web' }), {}, 'no single container named api (web)'],
    ['no running task', liveContainer(), { runningCount: 0 }, 'runs no task'],
    ['a draining service', liveContainer(), { status: 'DRAINING' }, 'not ACTIVE'],
    [
      'two deployments',
      liveContainer(),
      {
        deployments: [
          { status: 'PRIMARY', taskDefinition: TASK_DEFINITION_ARN, runningCount: 1 },
          { status: 'ACTIVE', taskDefinition: `${TASK_DEFINITION_ARN.slice(0, -1)}6`, runningCount: 1 },
        ],
      },
      '2 deployments',
    ],
    [
      'a deployment of another revision',
      liveContainer(),
      { deployments: [{ status: 'PRIMARY', taskDefinition: `${TASK_DEFINITION_ARN.slice(0, -1)}6`, runningCount: 1 }] },
      'another task definition',
    ],
    ['no deployment', liveContainer(), { deployments: [] }, '0 deployments'],
  ]
  for (const [what, container, service, message] of cases) {
    it(`live run 10: ${what} fails the step`, async () => {
      const found = await problemsFor(container, service)
      expect(found.join('; ')).toContain(message)
    })
  }

  it('live run 10: two containers named api fail the step', async () => {
    const answers = liveAnswers()
    const body = answers.taskDefinition.taskDefinition as { containerDefinitions: unknown[] }
    body.containerDefinitions.push(liveContainer())
    expect(problems(await read(answers), TAG).join('; ')).toContain('no single container named api')
  })

  it('live run 10: an answer for another family or another task definition fails the step', async () => {
    const answers = liveAnswers()
    const body = answers.taskDefinition.taskDefinition as Record<string, unknown>
    body.family = 'other'
    body.taskDefinitionArn = TASK_DEFINITION_ARN.replace('ascrum-demo-api', 'other')
    const found = problems(await read(answers), TAG).join('; ')
    expect(found).toContain('the family is other')
    expect(found).toContain('another task definition')
  })

  it('live run 10: a refused or empty answer stops the step with an error (no record is a pass)', async () => {
    const denied = 'An error occurred (AccessDeniedException) when calling the DescribeServices operation: no'
    await expect(read({ ...liveAnswers(), refused: { 'describe-services': denied } })).rejects.toThrow(
      /describe-services .*failed .*AccessDeniedException/,
    )
    await expect(
      read({ ...liveAnswers(), refused: { 'list-stack-resources': 'An error occurred (ValidationError)' } }),
    ).rejects.toThrow(/list-stack-resources/)
    await expect(read({ ...liveAnswers(), resources: { StackResourceSummaries: [] } })).rejects.toThrow(
      'AscrumDemo has 0 ECS services',
    )
    const two = liveAnswers()
    two.resources.StackResourceSummaries.push({ ResourceType: 'AWS::ECS::Service', PhysicalResourceId: 'x' })
    await expect(read(two)).rejects.toThrow('AscrumDemo has 2 ECS services')
    await expect(
      read({ ...liveAnswers(), services: { services: [], failures: [{ arn: SERVICE_ARN, reason: 'MISSING' }] } }),
    ).rejects.toThrow("describe-services did not answer for the demo's service (MISSING)")
    await expect(read({ ...liveAnswers(), services: { services: [{ serviceArn: 'other' }] } })).rejects.toThrow(
      'no such service',
    )
  })

  it('live run 10: a service without a task definition, or an empty describe-task-definition, fails the step', async () => {
    const without = problems(await read(liveAnswers(liveContainer(), { taskDefinition: undefined })), TAG)
    expect(without).toContain('no task definition was described')
    const empty = problems(await read({ ...liveAnswers(), taskDefinition: {} }), TAG)
    expect(empty).toContain('no task definition was described')
  })

  it('live run 10: no service in the record is a problem, never a pass', () => {
    const record: LiveRecord = {
      stack: 'AscrumDemo',
      cluster: 'ascrum-demo',
      service: null,
      taskDefinition: null,
      containers: [],
      container: null,
    }
    expect(problems(record, TAG)).toEqual(['no service was described'])
  })
})

describe('live run 10: what the step expects is what the demo stack sets', () => {
  it('live run 10: EXPECTED matches the synthesised API container (demoStack.ts), so the two cannot drift apart', () => {
    const { templates } = synth({
      demoDeploy: 'true',
      imageTag: TAG,
      originSecret: 'testoriginsecret'.repeat(4),
      cloudFrontPrefixListId: 'pl-3b927c52',
    })
    const definitions = Object.values(
      (templates.demo.toJSON() as { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> })
        .Resources,
    ).filter((r) => r.Type === 'AWS::ECS::TaskDefinition')
    expect(definitions).toHaveLength(1)
    const properties = definitions[0]?.Properties ?? {}
    expect(properties.Family).toBe(EXPECTED.family)
    const containers = properties.ContainerDefinitions as Record<string, unknown>[]
    expect(containers.map((c) => c.Name)).toEqual([EXPECTED.container])
    const container = containers[0] ?? {}
    expect(container.User).toBe(EXPECTED.user)
    expect(container.ReadonlyRootFilesystem).toBe(EXPECTED.readonlyRootFilesystem)
    expect(container.LinuxParameters).toEqual({
      InitProcessEnabled: EXPECTED.initProcessEnabled,
      Capabilities: { Drop: [...EXPECTED.drop] },
    })
    expect(JSON.stringify(container.Image)).toContain(`/${EXPECTED.repository}:${TAG}`)
  })
})
