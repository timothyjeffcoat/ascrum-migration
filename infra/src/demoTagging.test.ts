// Live run 4 (worklog, 2026-11-25): CloudFormation could not tag the VPC and the internet gateway. Every
// resource type of the synthesised AscrumDemo stack must have a row in the tagging table, and every row's
// tagging actions must be allowed by the execution-policy statements it names.
import { describe, expect, it } from 'vitest'
import { DEMO_TAGGING } from './demoTagging.ts'
import { actionsOf, ofType, synth, type Statement } from './testApp.ts'

const { templates, assembly } = synth()
// The template as the cloud assembly holds it (what `cdk deploy` sends). The CLI also adds CDK's own
// AWS::CDK::Metadata resource (version reporting), which an in-process synth leaves out; its row stays.
const deployed = assembly.getStackByName('AscrumDemo').template as { Resources: Record<string, { Type: string }> }
const CLI_ONLY = ['AWS::CDK::Metadata']

const executionStatements: Statement[] = ofType(templates.bootstrap, 'AWS::IAM::ManagedPolicy')
  .filter(([, r]) => String(r.Properties?.ManagedPolicyName).startsWith('ascrum-cdk-cfn-execution-'))
  .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Statement[] }).Statement)
const bySid = (sid: string) => executionStatements.find((s) => s.Sid === sid)
const grants = (pattern: string, action: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(action)

describe('live run 4: how each demo resource type is tagged, and what allows it', () => {
  it('live run 4: every resource type in the synthesised AscrumDemo template has a row, and no row is stale', () => {
    const types = [...new Set([...Object.values(deployed.Resources).map((r) => r.Type), ...CLI_ONLY])].sort()
    expect(types.length).toBeGreaterThan(20)
    expect(Object.keys(DEMO_TAGGING).sort()).toEqual(types)
  })

  it('live run 4: a type tagged on create carries the demo tag in the template; an untagged type has no tags', () => {
    for (const [type, row] of Object.entries(DEMO_TAGGING)) {
      for (const [id, resource] of ofType(templates.demo, type)) {
        const tags = resource.Properties?.Tags as { Key: string; Value: string }[] | undefined
        if (row.tagging === 'create') {
          expect(tags, `${type} ${id}`).toContainEqual({ Key: 'project', Value: 'ascrum-migration' })
        } else {
          expect(tags, `${type} ${id}`).toBeUndefined()
        }
      }
    }
  })

  it('live run 4: every tagging action of every row is allowed by the statement the row names', () => {
    for (const [type, row] of Object.entries(DEMO_TAGGING)) {
      expect(row.actions.length > 0, type).toBe(row.tagging === 'create')
      for (const action of row.actions) {
        const allowed = row.statements.some((sid) => {
          const statement = bySid(sid)
          expect(statement, `${type}: no statement ${sid}`).toBeDefined()
          return statement?.Effect === 'Allow' && actionsOf(statement).some((pattern) => grants(pattern, action))
        })
        expect(allowed, `${type}: ${action} via ${row.statements.join(', ')}`).toBe(true)
      }
    }
  })

  it('live run 4: ec2:CreateAction holds the bare API names of the network creates ("CreateVpc", never "ec2:CreateVpc"), with the demo tag in the request', () => {
    const creates = [
      ...new Set(
        ['NetworkCreateTagged', 'NetworkCreateChildTagged'].flatMap((sid) => actionsOf(bySid(sid) as Statement)),
      ),
    ]
    const condition = (bySid('NetworkTagOnCreate') as Statement).Condition?.StringEquals ?? {}
    expect(condition['ec2:CreateAction']).toEqual(expect.arrayContaining(creates.map((a) => a.replace(/^ec2:/, ''))))
    expect((condition['ec2:CreateAction'] as string[]).every((value) => /^Create[A-Za-z]+$/.test(value))).toBe(true)
    expect(condition['ec2:CreateAction']).toHaveLength(creates.length)
    expect(condition['aws:RequestTag/project']).toBe('ascrum-migration')
    // Every network type tagged on create is created by one of those calls.
    for (const [type, row] of Object.entries(DEMO_TAGGING)) {
      if (!row.statements.includes('NetworkTagOnCreate')) continue
      const create = `Create${type.replace('AWS::EC2::', '').replace('VPC', 'Vpc')}`
      expect(condition['ec2:CreateAction'], type).toContain(create)
    }
  })
})
