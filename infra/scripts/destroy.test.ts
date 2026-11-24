import { describe, expect, it } from 'vitest'
import { destroyDemo } from './destroy.ts'
import { fakeAws, type FakeWorld } from './fakeAws.ts'

const REGION = 'eu-west-1'
const BUCKET = 'ascrum-demo-web-123456789012-eu-west-1'
const noSleep = async () => {}

function deployed(): FakeWorld {
  return {
    stacks: {
      AscrumDemo: { states: ['CREATE_COMPLETE'], bucket: BUCKET },
      AscrumDemoRegistry: { states: ['CREATE_COMPLETE'] },
    },
    bucketObjects: { [BUCKET]: 12 },
  }
}

const deleteCalls = (calls: string[][]) => calls.filter((args) => args[1] === 'delete-stack').map((args) => args[3])

async function run(world: FakeWorld, extra: { timeoutMs?: number } = {}) {
  const { aws, calls } = fakeAws(world)
  const log: string[] = []
  const result = await destroyDemo({
    aws,
    region: REGION,
    sleep: noSleep,
    log: (l) => log.push(l),
    pollMs: 1,
    ...extra,
  })
  return { result, calls, log }
}

describe('AC-AWS-04: destroy', () => {
  it('AC-AWS-04: deletes the demo stack (bucket emptied first), then the registry', async () => {
    const world = deployed()
    const { result, calls, log } = await run(world)
    expect(result).toEqual({ deleted: ['AscrumDemo', 'AscrumDemoRegistry'], absent: [] })
    expect(deleteCalls(calls)).toEqual(['AscrumDemo', 'AscrumDemoRegistry'])
    const rm = calls.findIndex((args) => args[0] === 's3' && args[1] === 'rm')
    const firstDelete = calls.findIndex((args) => args[1] === 'delete-stack')
    expect(rm).toBeGreaterThanOrEqual(0)
    expect(rm).toBeLessThan(firstDelete)
    expect(world.bucketObjects?.[BUCKET]).toBe(0)
    // The account id never reaches the log (spec §11).
    expect(log.join('\n')).not.toMatch(/123456789012/)
  })

  it('AC-AWS-04: a second run is a no-op (nothing deleted, nothing changed)', async () => {
    const world = deployed()
    await run(world)
    const second = await run(world)
    expect(second.result).toEqual({ deleted: [], absent: ['AscrumDemo', 'AscrumDemoRegistry'] })
    expect(second.calls.every((args) => args[1] === 'describe-stacks')).toBe(true)
  })

  it('AC-AWS-04: with nothing ever deployed, it only looks', async () => {
    const { result, calls } = await run({ stacks: {} })
    expect(result.deleted).toEqual([])
    expect(deleteCalls(calls)).toEqual([])
  })

  it('AC-AWS-04: after a partial deploy (demo rolled back, registry created) both go', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = { states: ['ROLLBACK_COMPLETE'] }
    const { result } = await run(world)
    expect(result.deleted).toEqual(['AscrumDemo', 'AscrumDemoRegistry'])
  })

  it('AC-AWS-04: after a cancelled run, waits for the create to stop, then deletes', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = {
      states: ['CREATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_COMPLETE'],
      bucket: BUCKET,
    }
    const { result, calls } = await run(world)
    expect(result.deleted).toContain('AscrumDemo')
    const statuses = calls.filter((args) => args[1] === 'describe-stacks' && args[3] === 'AscrumDemo').length
    expect(statuses).toBeGreaterThanOrEqual(4)
  })

  it('AC-AWS-04: an update in progress is cancelled before the delete', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = { states: ['UPDATE_IN_PROGRESS'], bucket: BUCKET }
    const { result, calls } = await run(world)
    expect(result.deleted).toContain('AscrumDemo')
    expect(calls.some((args) => args[1] === 'cancel-update-stack')).toBe(true)
  })

  it('AC-AWS-04: a delete already in progress is waited for, not started again', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = { states: ['DELETE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'GONE'], bucket: BUCKET }
    const { result, calls } = await run(world)
    expect(result.deleted).toContain('AscrumDemo')
    expect(deleteCalls(calls)).toEqual(['AscrumDemoRegistry'])
  })

  it('AC-AWS-04: a failed delete is retried once, and logs why it failed', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = {
      states: ['CREATE_COMPLETE'],
      onDelete: [
        ['DELETE_IN_PROGRESS', 'DELETE_FAILED'],
        ['DELETE_IN_PROGRESS', 'GONE'],
      ],
    }
    const { result, calls, log } = await run(world)
    expect(result.deleted).toContain('AscrumDemo')
    expect(deleteCalls(calls).filter((name) => name === 'AscrumDemo')).toHaveLength(2)
    expect(log.join('\n')).toMatch(/DELETE_FAILED/)
  })

  it('AC-AWS-04: fails loudly when a stack cannot be deleted twice', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = {
      states: ['CREATE_COMPLETE'],
      onDelete: [
        ['DELETE_IN_PROGRESS', 'DELETE_FAILED'],
        ['DELETE_IN_PROGRESS', 'DELETE_FAILED'],
      ],
    }
    await expect(run(world)).rejects.toThrow(/AscrumDemo could not be deleted/)
  })

  it('AC-AWS-04: gives up after the timeout instead of hanging', async () => {
    const world = deployed()
    world.stacks.AscrumDemo = { states: ['CREATE_IN_PROGRESS'] }
    await expect(run(world, { timeoutMs: 10 })).rejects.toThrow(/still CREATE_IN_PROGRESS/)
  })

  it('AC-AWS-04 (S13): a failed `s3 rm` stops the destroy; the bucket is never taken as emptied', async () => {
    const world = deployed()
    world.s3RmError = { [BUCKET]: 'An error occurred (AccessDenied) when calling the ListObjectsV2 operation' }
    const { aws, calls } = fakeAws(world)
    await expect(destroyDemo({ aws, region: REGION, sleep: noSleep, log: () => {}, pollMs: 1 })).rejects.toThrow(
      'emptying s3://ascrum-demo-web-***-eu-west-1 failed',
    )
    expect(deleteCalls(calls)).toEqual([])
  })

  it('AC-AWS-04 (S22): a describe-stacks error that is not "does not exist" (AccessDenied) fails the destroy', async () => {
    const world = deployed()
    world.describeStacksError = {
      AscrumDemo:
        'An error occurred (AccessDenied) when calling the DescribeStacks operation: User is not authorized to perform: cloudformation:DescribeStacks',
    }
    const { aws, calls } = fakeAws(world)
    await expect(destroyDemo({ aws, region: REGION, sleep: noSleep, log: () => {}, pollMs: 1 })).rejects.toThrow(
      'describe-stacks AscrumDemo failed',
    )
    expect(deleteCalls(calls)).toEqual([])
  })
})
