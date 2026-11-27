import { describe, expect, it } from 'vitest'
import { redact, type Aws } from './aws.ts'
import { fakeAws, type FakeWorld } from './fakeAws.ts'
import { findLeftovers, formatReport, isGhost } from './leftovers.ts'

const REGION = 'eu-west-1'
const ACCOUNT = '123456789012'
const demo = { project: 'ascrum-migration', 'ascrum-env': 'demo' }
const bootstrap = { project: 'ascrum-migration', 'ascrum-env': 'bootstrap' }
const ALB = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/AscrumDemo-LoadB-1/abc`
const TASK_DEF = `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/AscrumDemoApiTask:1`
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/AscrumDemo-Cluster`
const SECRET = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!db-123-abc`
const BUDGET = `arn:aws:budgets::${ACCOUNT}:budget/ascrum-demo-monthly`
const ROLE_POLICY = `arn:aws:iam::${ACCOUNT}:policy/ascrum-demo-role-boundary`
const DISTRIBUTION = `arn:aws:cloudfront::${ACCOUNT}:distribution/E123`
// Live run 6: the two ARNs the tagging index still listed after the destroy.
const SERVICE = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/ascrum-demo/AscrumDemo-ApiServiceC9037CF0-mABjA6XISVgD`
const TASK = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/ascrum-demo/52eadf489a174a1db91daddd286dd6c6`
const TASK_2 = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/ascrum-demo/0123456789abcdef0123456789abcdef`
const DEMO_CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/ascrum-demo`
// A task of a second cluster (sec-03 / E2).
const OTHER_TASK = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/other-cluster/fedcba9876543210fedcba9876543210`

// fakeAws answers DescribeClusters without `clusterArn` (fakeAws.ts is outside the DEV-p5-infra-50 follow-up's
// owned paths). A real answer names each cluster's ARN, and isGhost now requires it, so the tests that use
// the fake's clusterStatus add it here. The fake still records the call.
function withClusterArns(aws: Aws): Aws {
  return async (args) => {
    const result = await aws(args)
    if (args[0] !== 'ecs' || args[1] !== 'describe-clusters' || result.code !== 0) return result
    const asked = args[args.indexOf('--clusters') + 1]
    const answer = JSON.parse(result.stdout) as { clusters?: { status?: string }[] }
    const clusters = (answer.clusters ?? []).map((cluster) => ({ clusterArn: asked, ...cluster }))
    return { ...result, stdout: JSON.stringify({ clusters, failures: [] }) }
  }
}

async function check(world: FakeWorld, sleep: () => Promise<void> = async () => {}) {
  const aws = withClusterArns(fakeAws(world).aws)
  let sleeps = 0
  const report = await findLeftovers({
    aws,
    region: REGION,
    attempts: 3,
    pollMs: 1,
    sleep: async () => {
      sleeps++
      await sleep()
    },
  })
  return { report, sleeps }
}

describe('AC-AWS-04: the final leftover check', () => {
  it('AC-AWS-04: passes when only the bootstrap and the budget remain', async () => {
    const { report } = await check({
      stacks: {},
      tagged: { [REGION]: { [ROLE_POLICY]: bootstrap }, 'us-east-1': { [BUDGET]: bootstrap } },
    })
    expect(report.ok).toBe(true)
    expect(report.kept).toEqual([ROLE_POLICY, BUDGET])
  })

  it('AC-AWS-04: fails when a demo resource remains (after retrying for the tagging index)', async () => {
    const { report, sleeps } = await check({ stacks: {}, tagged: { [REGION]: { [ALB]: demo } } })
    expect(report.ok).toBe(false)
    expect(report.remaining).toEqual([ALB])
    expect(sleeps).toBe(2)
    const text = formatReport(report).join('\n')
    expect(text).toMatch(/LEFTOVER/)
    expect(text).toMatch(/FAILED: demo resources remain/)
  })

  it('AC-AWS-04: a resource tagged with the project but not as bootstrap counts as a leftover', async () => {
    const { report } = await check({
      stacks: {},
      tagged: { 'us-east-1': { [DISTRIBUTION]: { project: 'ascrum-migration' } } },
    })
    expect(report.remaining).toEqual([DISTRIBUTION])
  })

  it('AC-AWS-04: fails when a demo stack still exists', async () => {
    const { report, sleeps } = await check({ stacks: { AscrumDemo: { states: ['DELETE_FAILED'] } }, tagged: {} })
    expect(report.ok).toBe(false)
    expect(report.stacks).toEqual(['AscrumDemo (DELETE_FAILED)'])
    expect(sleeps).toBe(0)
  })

  it('AC-AWS-04: deregistered task definitions, inactive clusters and secrets pending deletion are not leftovers', async () => {
    const { report } = await check({
      stacks: {},
      tagged: { [REGION]: { [TASK_DEF]: demo, [CLUSTER]: demo, [SECRET]: demo } },
      taskDefinitionStatus: { [TASK_DEF]: 'INACTIVE' },
      clusterStatus: { [CLUSTER]: 'INACTIVE' },
      secretDeleted: { [SECRET]: true },
    })
    expect(report.ok).toBe(true)
    expect(report.gone).toEqual([TASK_DEF, CLUSTER, SECRET])
  })

  it('AC-AWS-04: an active task definition is a leftover', async () => {
    const { report } = await check({ stacks: {}, tagged: { [REGION]: { [TASK_DEF]: demo } } })
    expect(report.remaining).toEqual([TASK_DEF])
  })

  it('AC-AWS-04: a resource the tagging index drops on a later look passes', async () => {
    const world: FakeWorld = { stacks: {}, tagged: { [REGION]: { [ALB]: demo } } }
    const { report, sleeps } = await check(world, async () => {
      world.tagged = { [REGION]: {} }
    })
    expect(report.ok).toBe(true)
    expect(sleeps).toBe(1)
  })

  it('AC-AWS-04: the report never prints an account id (spec §11)', async () => {
    const { report } = await check({ stacks: {}, tagged: { [REGION]: { [ALB]: demo, [ROLE_POLICY]: bootstrap } } })
    expect(formatReport(report).join('\n')).not.toContain(ACCOUNT)
  })

  it('AC-AWS-04 (S20): a failed get-resources fails the check; it is never read as "nothing tagged"', async () => {
    const world: FakeWorld = {
      stacks: {},
      tagged: {},
      taggingError: {
        'us-east-1': 'An error occurred (AccessDeniedException) when calling the GetResources operation',
      },
    }
    await expect(check(world)).rejects.toThrow('get-resources in us-east-1 failed')
  })

  it('AC-AWS-04 (S22): a describe-stacks AccessDenied fails the check; only "does not exist" means absent', async () => {
    const world: FakeWorld = {
      stacks: {},
      tagged: {},
      describeStacksError: {
        AscrumDemoRegistry: 'An error occurred (AccessDenied) when calling the DescribeStacks operation',
      },
    }
    await expect(check(world)).rejects.toThrow('describe-stacks AscrumDemoRegistry failed')
  })

  it('AC-AWS-04 / O4 (S14): only ECS task definitions, clusters, services and tasks and secrets can be ghosts; RDS, EC2, ELB, CloudFront, S3, logs and ECR are leftovers without asking', async () => {
    const billable = [
      `arn:aws:rds:${REGION}:${ACCOUNT}:db:ascrum-demo-db`,
      `arn:aws:rds:${REGION}:${ACCOUNT}:subgrp:ascrum-demo-db`,
      `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0abc`,
      `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0abc`,
      ALB,
      DISTRIBUTION,
      'arn:aws:s3:::ascrum-demo-web-bucket',
      `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/ascrum/demo/api`,
      `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/ascrum-demo-api`,
    ]
    const { aws, calls } = fakeAws({ stacks: {} })
    for (const arn of billable) expect(await isGhost(aws, arn), arn).toBe(false)
    expect(calls).toEqual([])
    const { report } = await check({
      stacks: {},
      tagged: { [REGION]: Object.fromEntries(billable.map((a) => [a, demo])) },
    })
    expect(report.ok).toBe(false)
    expect(report.remaining).toEqual(billable)
  })

  it('AC-AWS-04 (S19): a secret that is not pending deletion is a leftover', async () => {
    const { report } = await check({ stacks: {}, tagged: { [REGION]: { [SECRET]: demo } }, secretDeleted: {} })
    expect(report.ok).toBe(false)
    expect(report.remaining).toEqual([SECRET])
  })

  it('AC-AWS-04: an active cluster is a leftover', async () => {
    const { report } = await check({ stacks: {}, tagged: { [REGION]: { [CLUSTER]: demo } } })
    expect(report.remaining).toEqual([CLUSTER])
  })

  // DEV-p5-infra-50 (sec-02): the cluster branch had read `clusters.every(INACTIVE)`, true for an empty list
  // and blind to which cluster the answer named. Gone now only when the answer names the asked ARN exactly
  // once, as INACTIVE or as a MISSING failure (owner decision, 2026-11-27).
  describe('DEV-p5-infra-50: a DescribeClusters answer clears only the asked cluster', () => {
    const OTHER_CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/other-cluster`
    const answering = (stdout: string): Aws => async (args) => {
      expect(args.slice(0, 4)).toEqual(['ecs', 'describe-clusters', '--clusters', CLUSTER])
      return { code: 0, stdout, stderr: '' }
    }
    const ghost = (answer: unknown) => isGhost(answering(JSON.stringify(answer)), CLUSTER)

    it('DEV-p5-infra-50: an empty answer ({clusters:[],failures:[]}) is not gone', async () => {
      expect(await ghost({ clusters: [], failures: [] })).toBe(false)
      expect(await ghost({})).toBe(false)
    })

    it('DEV-p5-infra-50: a failure for the asked ARN with a reason other than MISSING is not gone', async () => {
      expect(await ghost({ clusters: [], failures: [{ arn: CLUSTER, reason: 'SOMETHING_ELSE' }] })).toBe(false)
    })

    it('DEV-p5-infra-50: an INACTIVE entry or a MISSING failure for another cluster is not gone', async () => {
      expect(await ghost({ clusters: [{ clusterArn: OTHER_CLUSTER, status: 'INACTIVE' }], failures: [] })).toBe(false)
      expect(await ghost({ clusters: [], failures: [{ arn: OTHER_CLUSTER, reason: 'MISSING' }] })).toBe(false)
      expect(await ghost({ clusters: [{ status: 'INACTIVE' }], failures: [] })).toBe(false)
    })

    it('DEV-p5-infra-50: the INACTIVE entry for the asked ARN is gone', async () => {
      expect(await ghost({ clusters: [{ clusterArn: CLUSTER, status: 'INACTIVE' }], failures: [] })).toBe(true)
    })

    it('DEV-p5-infra-50: a MISSING failure for the asked ARN is gone', async () => {
      expect(await ghost({ clusters: [], failures: [{ arn: CLUSTER, reason: 'MISSING' }] })).toBe(true)
    })

    it('DEV-p5-infra-50: an ACTIVE asked cluster, a contradictory answer or one that is not JSON is not gone', async () => {
      expect(await ghost({ clusters: [{ clusterArn: CLUSTER, status: 'ACTIVE' }], failures: [] })).toBe(false)
      expect(
        await ghost({
          clusters: [{ clusterArn: CLUSTER, status: 'INACTIVE' }],
          failures: [{ arn: CLUSTER, reason: 'MISSING' }],
        }),
      ).toBe(false)
      expect(
        await ghost({
          clusters: [
            { clusterArn: CLUSTER, status: 'INACTIVE' },
            { clusterArn: CLUSTER, status: 'ACTIVE' },
          ],
        }),
      ).toBe(false)
      expect(await isGhost(answering('not json'), CLUSTER)).toBe(false)
    })

    it('DEV-p5-infra-50: an empty answer keeps the cluster a LEFTOVER in the final check', async () => {
      const fake = fakeAws({ stacks: {}, tagged: { [REGION]: { [CLUSTER]: demo } } })
      const aws: Aws = async (args) =>
        args[1] === 'describe-clusters'
          ? { code: 0, stdout: JSON.stringify({ clusters: [], failures: [] }), stderr: '' }
          : fake.aws(args)
      const report = await findLeftovers({ aws, region: REGION, attempts: 1 })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([CLUSTER])
    })
  })

  describe('live run 6: ECS services and tasks the tagging index still lists', () => {
    const tagged = (...arns: string[]) => ({ [REGION]: Object.fromEntries(arns.map((a) => [a, demo])) })

    it('AC-AWS-04 / live run 6: an INACTIVE service and a STOPPED or MISSING task are gone, asked in one call per cluster and kind', async () => {
      const world: FakeWorld = {
        stacks: {},
        tagged: tagged(SERVICE, TASK, TASK_2),
        serviceStatus: { [SERVICE]: 'INACTIVE' },
        taskStatus: { [TASK]: 'STOPPED', [TASK_2]: 'MISSING' },
      }
      const { aws, calls } = fakeAws(world)
      const report = await findLeftovers({ aws, region: REGION, attempts: 1, pollMs: 1, sleep: async () => {} })
      expect(report.ok).toBe(true)
      expect(report.gone).toEqual([SERVICE, TASK, TASK_2])
      expect(report.remaining).toEqual([])
      const ecsCalls = calls.filter(([service]) => service === 'ecs')
      expect(ecsCalls).toEqual([
        ['ecs', 'describe-services', '--cluster', DEMO_CLUSTER, '--services', SERVICE, '--region', REGION],
        ['ecs', 'describe-tasks', '--cluster', DEMO_CLUSTER, '--tasks', TASK, TASK_2, '--region', REGION],
      ])
    })

    it('AC-AWS-04 / live run 6: services are described 10 at a time (the DescribeServices limit)', async () => {
      const services = Array.from({ length: 12 }, (_, i) => `${SERVICE}-${i}`)
      const world: FakeWorld = {
        stacks: {},
        tagged: tagged(...services),
        serviceStatus: Object.fromEntries(services.map((a) => [a, 'INACTIVE'])),
      }
      const { aws, calls } = fakeAws(world)
      const report = await findLeftovers({ aws, region: REGION, attempts: 1, pollMs: 1, sleep: async () => {} })
      expect(report.ok).toBe(true)
      const batches = calls.filter(([, command]) => command === 'describe-services')
      expect(batches.map((c) => c.length - 7)).toEqual([10, 2]) // 7 = ecs, describe-services, --cluster, arn, --services, --region, region
    })

    for (const status of ['ACTIVE', 'DRAINING']) {
      it(`AC-AWS-04 / live run 6: a ${status} service is a leftover`, async () => {
        const { report } = await check({ stacks: {}, tagged: tagged(SERVICE), serviceStatus: { [SERVICE]: status } })
        expect(report.ok).toBe(false)
        expect(report.remaining).toEqual([SERVICE])
      })
    }

    // Q-p5-infra-13: DeleteService says an INACTIVE service may be purged; ECS then answers MISSING.
    it('AC-AWS-04 / Q-p5-infra-13: a MISSING service is gone', async () => {
      const { report } = await check({ stacks: {}, tagged: tagged(SERVICE), serviceStatus: { [SERVICE]: 'MISSING' } })
      expect(report.ok).toBe(true)
      expect(report.gone).toEqual([SERVICE])
    })

    it('AC-AWS-04 / Q-p5-infra-13: a service failure with any other reason is a leftover', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        serviceStatus: { [SERVICE]: 'failure:ACCESS_DENIED' },
      })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([SERVICE])
    })

    // sec-03 / E4, and the reviewer's W04 (the same mutation; the second reason checks "exactly MISSING").
    for (const reason of ['ACCESS_DENIED', 'missing']) {
      it(`AC-AWS-04 / sec-03 (E4, W04): a task failure with reason ${reason} is a leftover`, async () => {
        const { report } = await check({
          stacks: {},
          tagged: tagged(TASK),
          taskStatus: { [TASK]: `failure:${reason}` },
        })
        expect(report.ok).toBe(false)
        expect(report.remaining).toEqual([TASK])
      })
    }

    it('AC-AWS-04 / sec-03 (E2): a stray ARN in one cluster’s answer does not clear a candidate of another cluster whose call failed', async () => {
      const fake = fakeAws({ stacks: {}, tagged: tagged(TASK, OTHER_TASK) })
      const stopped = (arn: string) => ({ taskArn: arn, lastStatus: 'STOPPED' })
      const report = await findLeftovers({
        aws: async (args) => {
          if (args[1] !== 'describe-tasks') return fake.aws(args)
          if (args.includes(DEMO_CLUSTER))
            return { code: 0, stderr: '', stdout: JSON.stringify({ tasks: [stopped(TASK), stopped(OTHER_TASK)] }) }
          return {
            code: 254,
            stdout: '',
            stderr: 'An error occurred (AccessDeniedException) when calling DescribeTasks',
          }
        },
        region: REGION,
        attempts: 1,
      })
      expect(report.gone).toEqual([TASK])
      expect(report.remaining).toEqual([OTHER_TASK])
    })

    it('AC-AWS-04 / W01: an answer that is not JSON leaves the whole batch as leftovers', async () => {
      const fake = fakeAws({ stacks: {}, tagged: tagged(TASK, TASK_2) })
      const report = await findLeftovers({
        aws: async (args) =>
          args[1] === 'describe-tasks' ? { code: 0, stderr: '', stdout: '<html>not json' } : fake.aws(args),
        region: REGION,
        attempts: 1,
      })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([TASK, TASK_2])
    })

    it('AC-AWS-04 / W03: a ClusterNotFoundException leaves the whole batch as leftovers', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(TASK, TASK_2),
        taskStatus: { [TASK]: 'STOPPED', [TASK_2]: 'MISSING' },
        ecsError: {
          'describe-tasks':
            'An error occurred (ClusterNotFoundException) when calling the DescribeTasks operation: Cluster not found.',
        },
      })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([TASK, TASK_2])
    })

    it('AC-AWS-04 / sec-03 (hardening): an ARN the answer names twice, or as found and as a failure, is a leftover', async () => {
      const fake = fakeAws({ stacks: {}, tagged: tagged(TASK, TASK_2) })
      const answer = {
        tasks: [
          { taskArn: TASK, lastStatus: 'STOPPED' },
          { taskArn: TASK, lastStatus: 'STOPPED' },
          { taskArn: TASK_2, lastStatus: 'STOPPED' },
        ],
        failures: [{ arn: TASK_2, reason: 'MISSING' }],
      }
      const report = await findLeftovers({
        aws: async (args) =>
          args[1] === 'describe-tasks' ? { code: 0, stderr: '', stdout: JSON.stringify(answer) } : fake.aws(args),
        region: REGION,
        attempts: 1,
      })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([TASK, TASK_2])
    })

    for (const status of ['RUNNING', 'PENDING', 'PROVISIONING', 'DEPROVISIONING', 'STOPPING']) {
      it(`AC-AWS-04 / live run 6: a ${status} task is a leftover`, async () => {
        const { report } = await check({ stacks: {}, tagged: tagged(TASK), taskStatus: { [TASK]: status } })
        expect(report.ok).toBe(false)
        expect(report.remaining).toEqual([TASK])
      })
    }

    it('AC-AWS-04 / live run 6: a refused or throttled describe fails the check; it never counts as gone', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE, TASK),
        serviceStatus: { [SERVICE]: 'INACTIVE' },
        taskStatus: { [TASK]: 'STOPPED' },
        ecsError: {
          'describe-services':
            'An error occurred (ThrottlingException) when calling the DescribeServices operation (reached max retries: 2): Rate exceeded',
          'describe-tasks': 'An error occurred (AccessDeniedException) when calling the DescribeTasks operation',
        },
      })
      expect(report.ok).toBe(false)
      expect(report.gone).toEqual([])
      expect(report.remaining).toEqual([SERVICE, TASK])
    })

    it('AC-AWS-04 / live run 6: an answer about another ARN does not clear the one asked about', async () => {
      const fake = fakeAws({ stacks: {}, tagged: tagged(TASK) })
      const report = await findLeftovers({
        aws: async (args) =>
          args[1] === 'describe-tasks'
            ? { code: 0, stderr: '', stdout: JSON.stringify({ tasks: [{ taskArn: TASK_2, lastStatus: 'STOPPED' }] }) }
            : fake.aws(args),
        region: REGION,
        attempts: 1,
      })
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([TASK])
    })

    it('AC-AWS-04 / live run 6: task definitions and clusters are still asked one by one, as before', async () => {
      const { aws: fake, calls } = fakeAws({
        stacks: {},
        tagged: tagged(TASK_DEF, CLUSTER),
        taskDefinitionStatus: { [TASK_DEF]: 'INACTIVE' },
        clusterStatus: { [CLUSTER]: 'INACTIVE' },
      })
      const report = await findLeftovers({ aws: withClusterArns(fake), region: REGION, attempts: 1 })
      expect(report.gone).toEqual([TASK_DEF, CLUSTER])
      expect(calls.filter(([service]) => service === 'ecs').map(([, command]) => command)).toEqual([
        'describe-task-definition',
        'describe-clusters',
      ])
    })
  })

  // Live run 7: a refused DescribeTasks printed only "LEFTOVER …"; the line now says why it was kept.
  describe('live run 7: each leftover line says why it was kept', () => {
    const tagged = (...arns: string[]) => ({ [REGION]: Object.fromEntries(arns.map((a) => [a, demo])) })
    const lineFor = (report: Awaited<ReturnType<typeof findLeftovers>>, arn: string) =>
      formatReport(report).find((line) => line.startsWith('  LEFTOVER') && line.includes(redact(arn))) ?? ''
    const answering = (world: FakeWorld, stdout: string) => {
      const fake = fakeAws(world)
      const aws: Aws = async (args) => (args[1] === 'describe-tasks' ? { code: 0, stderr: '', stdout } : fake.aws(args))
      return findLeftovers({ aws, region: REGION, attempts: 1 })
    }
    const REFUSED = `An error occurred (AccessDeniedException) when calling the DescribeTasks operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/ascrum-github-deploy/GitHubActions is not authorized to perform: ecs:DescribeTasks`

    it('AC-AWS-04 / live run 7: a refused describe says "describe refused" with the error code, and no account id', async () => {
      const { report } = await check({ stacks: {}, tagged: tagged(TASK), ecsError: { 'describe-tasks': REFUSED } })
      const line = lineFor(report, TASK)
      expect(line).toContain('(describe refused: AccessDeniedException)')
      expect(line).not.toContain(ACCOUNT)
    })

    it('AC-AWS-04 / live run 7: a failed describe says "describe failed" with the error code', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(TASK),
        ecsError: {
          'describe-tasks':
            'An error occurred (ClusterNotFoundException) when calling the DescribeTasks operation: Cluster not found.',
        },
      })
      expect(lineFor(report, TASK)).toContain('(describe failed: ClusterNotFoundException)')
    })

    it('AC-AWS-04 / live run 7: error text without a code is cut to its first line and 12-digit numbers are scrubbed', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        ecsError: {
          'describe-services': `Could not connect to the endpoint for account ${ACCOUNT} in ${REGION}\nsecond line`,
        },
      })
      const line = lineFor(report, SERVICE)
      expect(line).toContain(`(describe failed: Could not connect to the endpoint for account *** in ${REGION})`)
      expect(line).not.toContain(ACCOUNT)
      expect(line).not.toContain('second line')
    })

    for (const status of ['ACTIVE', 'DRAINING']) {
      it(`AC-AWS-04 / live run 7: a ${status} service says "(status ${status})"`, async () => {
        const { report } = await check({ stacks: {}, tagged: tagged(SERVICE), serviceStatus: { [SERVICE]: status } })
        expect(lineFor(report, SERVICE)).toContain(`(status ${status})`)
      })
    }

    it('AC-AWS-04 / live run 7: a task still running says "(lastStatus RUNNING)"', async () => {
      const { report } = await check({ stacks: {}, tagged: tagged(TASK), taskStatus: { [TASK]: 'RUNNING' } })
      expect(lineFor(report, TASK)).toContain('(lastStatus RUNNING)')
    })

    it('AC-AWS-04 / live run 7: a failure that is not MISSING says "(failure reason …)"', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(TASK),
        taskStatus: { [TASK]: 'failure:ACCESS_DENIED' },
      })
      expect(lineFor(report, TASK)).toContain('(failure reason ACCESS_DENIED)')
    })

    it('AC-AWS-04 / live run 7: an ARN the answer leaves out says "(not in the answer)"', async () => {
      const report = await answering({ stacks: {}, tagged: tagged(TASK) }, JSON.stringify({ tasks: [], failures: [] }))
      expect(report.remaining).toEqual([TASK])
      expect(lineFor(report, TASK)).toContain('(not in the answer)')
    })

    it('AC-AWS-04 / live run 7: an answer that is not JSON says "(answer not JSON)"', async () => {
      const report = await answering({ stacks: {}, tagged: tagged(TASK) }, '<html>not json')
      expect(lineFor(report, TASK)).toContain('(answer not JSON)')
    })

    it('AC-AWS-04 / live run 7: an ARN named twice says "(named more than once)"', async () => {
      const stopped = { taskArn: TASK, lastStatus: 'STOPPED' }
      const report = await answering(
        { stacks: {}, tagged: tagged(TASK) },
        JSON.stringify({ tasks: [stopped, stopped] }),
      )
      expect(lineFor(report, TASK)).toContain('(named more than once)')
    })

    it('AC-AWS-04 / live run 7: a billable type says "(not checked: billable type)"; an asked type that is still there says so', async () => {
      const { report } = await check({ stacks: {}, tagged: tagged(ALB, TASK_DEF) })
      expect(lineFor(report, ALB)).toContain('(not checked: billable type)')
      expect(lineFor(report, TASK_DEF)).toContain('(asked: not reported deleted)')
    })

    // DEV-p5-infra-37: isGhost's failed or refused describe calls had printed "asked: not reported deleted",
    // like an answer saying the resource is still there. They now say how the call failed; the decision is
    // unchanged (LEFTOVER, fail-closed).
    const failingOne = (world: FakeWorld, command: string, stderr: string) => {
      const fake = fakeAws(world)
      const aws: Aws = async (args) => (args[1] === command ? { code: 254, stdout: '', stderr } : fake.aws(args))
      return findLeftovers({ aws, region: REGION, attempts: 1 })
    }

    it('DEV-p5-infra-37: a refused DescribeClusters says "describe refused" and the cluster is still LEFTOVER', async () => {
      const report = await failingOne(
        { stacks: {}, tagged: tagged(CLUSTER) },
        'describe-clusters',
        `An error occurred (AccessDeniedException) when calling the DescribeClusters operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x is not authorized`,
      )
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([CLUSTER])
      expect(lineFor(report, CLUSTER)).toContain('(describe refused: AccessDeniedException)')
      expect(lineFor(report, CLUSTER)).not.toContain(ACCOUNT)
    })

    it('DEV-p5-infra-37: a failed DescribeTaskDefinition says "describe failed" and the task definition is still LEFTOVER', async () => {
      const report = await failingOne(
        { stacks: {}, tagged: tagged(TASK_DEF) },
        'describe-task-definition',
        'An error occurred (ThrottlingException) when calling the DescribeTaskDefinition operation: Rate exceeded',
      )
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([TASK_DEF])
      expect(lineFor(report, TASK_DEF)).toContain('(describe failed: ThrottlingException)')
    })

    it('DEV-p5-infra-46: a refused DescribeTaskDefinition is never gone; the task definition stays LEFTOVER with "describe refused"', async () => {
      const report = await failingOne(
        { stacks: {}, tagged: tagged(TASK_DEF) },
        'describe-task-definition',
        `An error occurred (AccessDeniedException) when calling the DescribeTaskDefinition operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x is not authorized to perform: ecs:DescribeTaskDefinition`,
      )
      expect(report.ok).toBe(false)
      expect(report.gone).toEqual([])
      expect(report.remaining).toEqual([TASK_DEF])
      expect(lineFor(report, TASK_DEF)).toContain('(describe refused: AccessDeniedException)')
      expect(lineFor(report, TASK_DEF)).not.toContain(ACCOUNT)
    })

    it('DEV-p5-infra-49: a refused or throttled DescribeSecret is never gone; the secret stays LEFTOVER with its reason', async () => {
      const cases = [
        [
          `An error occurred (AccessDeniedException) when calling the DescribeSecret operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x is not authorized to perform: secretsmanager:DescribeSecret`,
          '(describe refused: AccessDeniedException)',
        ],
        [
          `An error occurred (ThrottlingException) when calling the DescribeSecret operation (reached max retries: 2): Rate exceeded for ${ACCOUNT}`,
          '(describe failed: ThrottlingException)',
        ],
      ] as const
      for (const [stderr, reason] of cases) {
        const report = await failingOne({ stacks: {}, tagged: tagged(SECRET) }, 'describe-secret', stderr)
        expect(report.ok, reason).toBe(false)
        expect(report.gone, reason).toEqual([])
        expect(report.remaining, reason).toEqual([SECRET])
        expect(lineFor(report, SECRET), reason).toContain(reason)
        expect(lineFor(report, SECRET), reason).not.toContain(ACCOUNT)
      }
    })

    it('DEV-p5-infra-37: a DescribeSecret error other than not-found says "describe failed" and the secret is still LEFTOVER', async () => {
      const report = await failingOne(
        { stacks: {}, tagged: tagged(SECRET) },
        'describe-secret',
        `Could not connect to the endpoint for account ${ACCOUNT}\nsecond line`,
      )
      expect(report.ok).toBe(false)
      expect(report.remaining).toEqual([SECRET])
      expect(lineFor(report, SECRET)).toContain('(describe failed: Could not connect to the endpoint for account ***)')
    })

    it('DEV-p5-infra-37: a not-found answer is still gone, and an answered "still there" still says "asked: not reported deleted"', async () => {
      const gone = await failingOne(
        { stacks: {}, tagged: tagged(SECRET) },
        'describe-secret',
        'An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: not found',
      )
      expect(gone.ok).toBe(true)
      expect(gone.gone).toEqual([SECRET])
      const { report } = await check({ stacks: {}, tagged: tagged(TASK_DEF, CLUSTER, SECRET) })
      for (const arn of [TASK_DEF, CLUSTER, SECRET]) {
        expect(lineFor(report, arn), arn).toContain('(asked: not reported deleted)')
      }
    })

    // sec-04: AWS-supplied text must not forge lines, hide text or inject workflow commands.
    const physicalLines = (lines: string[]) => lines.join('\n').split(/\r\n|\r|\n/)
    const hasControl = (line: string) =>
      [...line].some((char) => {
        const code = char.codePointAt(0) ?? 0
        return code < 0x20 || (code >= 0x7f && code <= 0x9f)
      })

    it('AC-AWS-04 / sec-04: a status with a newline stays on its LEFTOVER line and cannot forge "OK:"', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        serviceStatus: { [SERVICE]: 'ACTIVE\nOK: nothing from the demo remains.\nRemaining: 0' },
      })
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('OK:'))).toEqual([])
      expect(lines.filter((line) => line.startsWith('Remaining:'))).toEqual(['Remaining: 1'])
      expect(lines.filter((line) => line.startsWith('  LEFTOVER'))).toHaveLength(1)
      expect(lineFor(report, SERVICE)).toContain('(status ACTIVE OK: nothing from the demo remains. Remaining: 0)')
    })

    it('AC-AWS-04 / sec-04: a failure reason with a carriage return and an ESC sequence prints without control characters', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(TASK),
        taskStatus: { [TASK]: 'failure:ACCESS\r\u001b[2K\u009b2KDENIED' },
      })
      const text = formatReport(report).join('\n')
      expect(text.split('\n').some((line) => hasControl(line))).toBe(false)
      expect(lineFor(report, TASK)).toContain('(failure reason ACCESS  [2K 2KDENIED)')
    })

    it('AC-AWS-04 / sec-04: error text with "\\r::add-mask::" cannot start an output line with "::"', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(TASK),
        ecsError: { 'describe-tasks': 'connection reset\r::add-mask::x\nsecond line' },
      })
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('::'))).toEqual([])
      expect(lineFor(report, TASK)).toContain('(describe failed: connection reset ::add-mask::x)')
    })

    it('AC-AWS-04 / sec-04: an ARN from the tagging index is printed without control characters too', async () => {
      const forged = `${ALB}\n::warning::forged\rOK: nothing from the demo remains.`
      const { report } = await check({ stacks: {}, tagged: tagged(forged) })
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('::') || line.startsWith('OK:'))).toEqual([])
      expect(report.remaining).toEqual([forged])
    })

    // sec-06 / DEV-p5-infra-40: the scrub and the strip on every printed path, not only the reasons.
    it('AC-AWS-04 / sec-06: a gone ARN line is printed without control characters or account id', async () => {
      const forged = `${TASK_DEF}\u001b[2J\n::warning::forged`
      const { report } = await check({
        stacks: {},
        tagged: tagged(forged),
        taskDefinitionStatus: { [forged]: 'INACTIVE' },
      })
      expect(report.gone).toEqual([forged])
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('::'))).toEqual([])
      const gone = lines.filter((line) => line.startsWith('  gone'))
      expect(gone).toHaveLength(1)
      expect(gone.some(hasControl)).toBe(false)
      expect(gone.join('')).not.toContain(ACCOUNT)
    })

    it('AC-AWS-04 / sec-06: a kept ARN line is printed without control characters or account id', async () => {
      const forged = `${ROLE_POLICY}\rOK: nothing from the demo remains.`
      const { report } = await check({ stacks: {}, tagged: { [REGION]: { [forged]: bootstrap } } })
      expect(report.ok).toBe(true)
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('OK:'))).toEqual(['OK: nothing from the demo remains.'])
      const kept = lines.filter((line) => line.startsWith('  kept'))
      expect(kept).toHaveLength(1)
      expect(kept.some(hasControl)).toBe(false)
      expect(kept.join('')).not.toContain(ACCOUNT)
    })

    it('AC-AWS-04 / sec-06: the region printed beside a leftover is printed without control characters', async () => {
      const forged = `arn:aws:elasticloadbalancing:eu-west-1\r\u001b[2KRemaining 0:${ACCOUNT}:loadbalancer/app/x/1`
      const { report } = await check({ stacks: {}, tagged: tagged(forged) })
      const lines = physicalLines(formatReport(report))
      const leftover = lines.filter((line) => line.startsWith('  LEFTOVER'))
      expect(leftover).toHaveLength(1)
      expect(lines.some(hasControl)).toBe(false)
      expect(leftover[0]).toContain('(eu-west-1  [2KRemaining 0)')
    })

    it('AC-AWS-04 / sec-06: the "Demo stacks still present" line is printed without control characters or account id', async () => {
      const { report } = await check({
        stacks: { AscrumDemo: { states: [`DELETE_FAILED\nOK: nothing from the demo remains.\u007f${ACCOUNT}`] } },
        tagged: {},
      })
      const lines = physicalLines(formatReport(report))
      expect(lines.filter((line) => line.startsWith('OK:'))).toEqual([])
      const stacksLine = lines.filter((line) => line.startsWith('Demo stacks still present:'))
      expect(stacksLine).toHaveLength(1)
      expect(stacksLine.some(hasControl)).toBe(false)
      expect(stacksLine.join('')).not.toContain(ACCOUNT)
    })

    it('AC-AWS-04 / sec-06: DEL (U+007F) in a reason becomes a space', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        serviceStatus: { [SERVICE]: 'ACTIVE\u007fX' },
      })
      expect(lineFor(report, SERVICE)).toContain('(status ACTIVE X)')
    })

    it('AC-AWS-04 / DEV-p5-infra-38: line separators, bidi controls and zero-width characters become spaces', async () => {
      const invisible = '  ‎‏‪‫‬‭‮⁦⁧⁨⁩​‌‍﻿'
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        serviceStatus: { [SERVICE]: `ACTIVE${invisible}X` },
      })
      const line = lineFor(report, SERVICE)
      expect([...invisible].filter((char) => line.includes(char))).toEqual([])
      expect(line).toContain(`(status ACTIVE${' '.repeat(invisible.length)}X)`)
    })

    it('AC-AWS-04 / R06: at most 160 characters of error text are echoed', async () => {
      const { report } = await check({
        stacks: {},
        tagged: tagged(SERVICE),
        ecsError: { 'describe-services': 'x'.repeat(300) },
      })
      const line = lineFor(report, SERVICE)
      expect(line).toContain(`(describe failed: ${'x'.repeat(160)})`)
      expect(line).not.toContain('x'.repeat(161))
    })

    it('AC-AWS-04 / live run 7: the summary lines are unchanged', async () => {
      const failed = await check({ stacks: {}, tagged: tagged(TASK), taskStatus: { [TASK]: 'RUNNING' } })
      const text = formatReport(failed.report)
      expect(text).toContain('Remaining: 1')
      expect(text.at(-1)).toBe('FAILED: demo resources remain (AC-AWS-04).')
      const passed = await check({ stacks: {}, tagged: tagged(TASK), taskStatus: { [TASK]: 'STOPPED' } })
      expect(formatReport(passed.report)).toContain('Remaining: 0')
      expect(formatReport(passed.report).at(-1)).toBe('OK: nothing from the demo remains.')
    })
  })
})
