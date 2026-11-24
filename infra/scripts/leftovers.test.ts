import { describe, expect, it } from 'vitest'
import { fakeAws, type FakeWorld } from './fakeAws.ts'
import { findLeftovers, formatReport } from './leftovers.ts'

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

async function check(world: FakeWorld, sleep: () => Promise<void> = async () => {}) {
  const { aws } = fakeAws(world)
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
})
