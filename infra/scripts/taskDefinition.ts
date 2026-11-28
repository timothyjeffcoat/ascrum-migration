// The live task definition in the deploy evidence (live run 10's caveat). Used by the deploy job of
// deploy-demo.yml once the demo answers over HTTPS, so a task is running:
//
//   AWS_REGION=… node infra/scripts/taskDefinition.ts <image tag> <evidence json>
//
// Live run 10 proved that the API runs on Fargate with the settings the code sets, but the evidence held
// only the code's copy of them (infra/src/demoStack.ts). This script asks AWS which task definition the
// demo's service runs, reads AWS's own copy of it, and keeps a small record: the service's deployment, the
// family and revision, and the API container's name, image, `user`, `readonlyRootFilesystem` and
// `linuxParameters`. It never keeps the environment, the secrets (not even their ARNs), the command or
// anything else of the container: only the fields named here are copied.
//
// It fails closed (exit 1) unless AWS's copy has every capability dropped and none added, the init
// process on, user 1000:1000, a read-only root filesystem and this commit's image, and unless the service
// runs exactly that one task definition. The record is written first, also when a check fails or a call
// is refused, so a red run shows why. It is an account-id-free file: redact() runs on it here, and the
// workflow's "Keep account ids out of the evidence" step runs after this one on every .json file.
//
// The calls need no new permission for the deploy role (infra/src/bootstrapStack.ts): ListStackResources
// on the demo stacks (sid DemoStacks), DescribeServices bound to the demo cluster (LeftoverEcsServices),
// and DescribeTaskDefinition on * (ReadOnlyChecks). The service has no fixed name, so its ARN comes from
// the demo stack's resources, as destroy.ts finds the web bucket.
import { writeFileSync } from 'node:fs'
import { NAMES, STACK } from '../src/names.ts'
import { awsCli, awsJson, commandData, printable, redact, runMain, type Aws } from './aws.ts'

/** What AWS's copy must say (demoStack.ts; taskDefinition.test.ts ties these to the synthesised stack). */
export const EXPECTED = {
  stack: STACK.demo,
  cluster: NAMES.cluster,
  family: NAMES.taskFamily,
  repository: NAMES.apiRepository,
  container: 'api',
  user: '1000:1000',
  drop: ['ALL'],
  initProcessEnabled: true,
  readonlyRootFilesystem: true,
} as const

type Deployment = { status?: string; taskDefinition?: string; runningCount?: number; rolloutState?: string }
type Service = {
  serviceArn?: string
  status?: string
  taskDefinition?: string
  runningCount?: number
  desiredCount?: number
  deployments?: Deployment[]
}
type LinuxParameters = { capabilities?: { add?: unknown; drop?: unknown }; initProcessEnabled?: unknown }
type ContainerDefinition = {
  name?: string
  image?: string
  user?: string
  readonlyRootFilesystem?: boolean
  linuxParameters?: LinuxParameters & Record<string, unknown>
}
type TaskDefinition = {
  taskDefinitionArn?: string
  family?: string
  revision?: number
  status?: string
  containerDefinitions?: ContainerDefinition[]
}

/** The evidence record: only these fields, never the environment or the secrets. */
export type LiveRecord = {
  stack: string
  cluster: string
  service: {
    arn: string | null
    status: string | null
    runningCount: number | null
    desiredCount: number | null
    taskDefinition: string | null
    deployments: {
      status: string | null
      taskDefinition: string | null
      runningCount: number | null
      rolloutState: string | null
    }[]
  } | null
  taskDefinition: { arn: string | null; family: string | null; revision: number | null; status: string | null } | null
  /** The names of every container in the task definition; only the API container's settings are kept. */
  containers: string[]
  container: {
    name: string
    image: string | null
    user: string | null
    readonlyRootFilesystem: boolean | null
    linuxParameters: Record<string, unknown> | null
  } | null
}

export type LiveOptions = { aws: Aws; region: string }

const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value)

/** Reads the service's task definition from AWS. Any refused or failed call throws (fail closed). */
export async function liveTaskDefinition({ aws, region }: LiveOptions): Promise<LiveRecord> {
  const where = ['--region', region]
  const record: LiveRecord = {
    stack: EXPECTED.stack,
    cluster: EXPECTED.cluster,
    service: null,
    taskDefinition: null,
    containers: [],
    container: null,
  }

  const resources = (await awsJson(aws, [
    'cloudformation',
    'list-stack-resources',
    '--stack-name',
    EXPECTED.stack,
    ...where,
  ])) as { StackResourceSummaries?: { ResourceType?: string; PhysicalResourceId?: string }[] } | null
  const services = (resources?.StackResourceSummaries ?? []).filter((r) => r.ResourceType === 'AWS::ECS::Service')
  const serviceArn = services.length === 1 ? services[0]?.PhysicalResourceId : undefined
  if (!serviceArn) {
    throw new Error(`${EXPECTED.stack} has ${services.length} ECS services; expected exactly one with an ARN.`)
  }

  const described = (await awsJson(aws, [
    'ecs',
    'describe-services',
    '--cluster',
    EXPECTED.cluster,
    '--services',
    serviceArn,
    ...where,
  ])) as { services?: Service[]; failures?: { arn?: string; reason?: string }[] } | null
  const failures = described?.failures ?? []
  const answered = (described?.services ?? []).filter((s) => s.serviceArn === serviceArn)
  const service = answered.length === 1 && failures.length === 0 ? answered[0] : undefined
  if (!service) {
    const reasons = failures.map((f) => f.reason ?? 'no reason').join(', ')
    throw new Error(`describe-services did not answer for the demo's service (${reasons || 'no such service'}).`)
  }
  record.service = {
    arn: serviceArn,
    status: orNull(service.status),
    runningCount: orNull(service.runningCount),
    desiredCount: orNull(service.desiredCount),
    taskDefinition: orNull(service.taskDefinition),
    deployments: (service.deployments ?? []).map((d) => ({
      status: orNull(d.status),
      taskDefinition: orNull(d.taskDefinition),
      runningCount: orNull(d.runningCount),
      rolloutState: orNull(d.rolloutState),
    })),
  }
  if (!service.taskDefinition) return record

  const body = (await awsJson(aws, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    service.taskDefinition,
    ...where,
  ])) as { taskDefinition?: TaskDefinition } | null
  const definition = body?.taskDefinition
  if (!definition) return record
  record.taskDefinition = {
    arn: orNull(definition.taskDefinitionArn),
    family: orNull(definition.family),
    revision: orNull(definition.revision),
    status: orNull(definition.status),
  }
  const containers = definition.containerDefinitions ?? []
  record.containers = containers.map((c) => c.name ?? '')
  const api = containers.filter((c) => c.name === EXPECTED.container)
  const container = api.length === 1 ? api[0] : undefined
  if (container) {
    record.container = {
      name: EXPECTED.container,
      image: orNull(container.image),
      user: orNull(container.user),
      readonlyRootFilesystem: orNull(container.readonlyRootFilesystem),
      // Kept whole: capabilities, the init process and the other kernel settings, none of which is a value
      // or a secret. Nothing outside linuxParameters is copied.
      linuxParameters: orNull(container.linuxParameters),
    }
  }
  return record
}

const same = (a: unknown, b: readonly unknown[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])

/** Every way AWS's copy differs from what the deploy must run; empty when it matches. */
export function problems(record: LiveRecord, imageTag: string): string[] {
  const found: string[] = []
  const service = record.service
  if (!service) return ['no service was described']
  if (service.status !== 'ACTIVE') found.push(`the service is ${service.status ?? 'without a status'}, not ACTIVE`)
  if ((service.runningCount ?? 0) < 1) found.push('the service runs no task')
  // A fresh stack has one deployment; then the running tasks can only be that task definition's.
  const [only, ...more] = service.deployments
  if (!only || more.length > 0) found.push(`the service has ${service.deployments.length} deployments, not 1`)
  else {
    if (only.status !== 'PRIMARY') found.push(`its deployment is ${only.status ?? 'without a status'}, not PRIMARY`)
    if (only.taskDefinition !== service.taskDefinition) found.push('its deployment runs another task definition')
    if ((only.runningCount ?? 0) < 1) found.push('its deployment runs no task')
  }
  const definition = record.taskDefinition
  if (!definition) return [...found, 'no task definition was described']
  if (definition.arn !== service.taskDefinition) found.push('AWS answered for another task definition')
  if (definition.family !== EXPECTED.family) found.push(`the family is ${definition.family}, not ${EXPECTED.family}`)
  if (definition.status !== 'ACTIVE') found.push(`the task definition is ${definition.status}, not ACTIVE`)
  const container = record.container
  if (!container) return [...found, `no single container named ${EXPECTED.container} (${record.containers.join(', ')})`]
  if (container.user !== EXPECTED.user) found.push(`user is ${container.user ?? 'unset'}, not ${EXPECTED.user}`)
  if (container.readonlyRootFilesystem !== EXPECTED.readonlyRootFilesystem) {
    found.push('the root filesystem is not read-only')
  }
  const linux = (container.linuxParameters ?? {}) as LinuxParameters
  if (!same(linux.capabilities?.drop, EXPECTED.drop)) found.push('capabilities.drop is not exactly ["ALL"]')
  const add = linux.capabilities?.add
  if (add !== undefined && !same(add, [])) found.push('capabilities.add is not empty')
  if (linux.initProcessEnabled !== EXPECTED.initProcessEnabled) found.push('initProcessEnabled is not true')
  if (!container.image?.endsWith(`/${EXPECTED.repository}:${imageTag}`)) {
    found.push(`the image is not this commit's ${EXPECTED.repository}:${imageTag}`)
  }
  return found
}

/** The evidence file's text: JSON with any account id scrubbed (spec §11). */
export const evidenceText = (value: unknown): string => `${redact(JSON.stringify(value, null, 2))}\n`

if (import.meta.main) {
  await runMain(async () => {
    const [imageTag, evidence] = process.argv.slice(2)
    const region = process.env.AWS_REGION
    if (!imageTag || !evidence || !region) {
      console.error('usage: AWS_REGION=… node taskDefinition.ts <image tag> <evidence json>')
      process.exit(2)
    }
    let record: LiveRecord
    try {
      record = await liveTaskDefinition({ aws: awsCli, region })
    } catch (error) {
      // The evidence says why there is no record; runMain prints the same line and exits 1.
      writeFileSync(
        evidence,
        evidenceText({ error: printable(error instanceof Error ? error.message : String(error)) }),
      )
      throw error
    }
    writeFileSync(evidence, evidenceText(record))
    const found = problems(record, imageTag)
    const name = `${record.taskDefinition?.family ?? '?'}:${record.taskDefinition?.revision ?? '?'}`
    if (found.length > 0) {
      for (const problem of found) console.error(`::error::${commandData(`live task definition ${name}: ${problem}`)}`)
      process.exit(1)
    }
    console.log(
      printable(
        `live task definition ${name}: user ${EXPECTED.user}, capabilities drop ALL, init process on, read-only root filesystem, image ${imageTag}.`,
      ),
    )
  })
}
