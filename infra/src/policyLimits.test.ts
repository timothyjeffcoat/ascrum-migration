// IAM and CloudFormation quotas, checked offline on worst-case values. The first live bootstrap failed
// with "Cannot exceed quota for PolicySize: 6144" on the single CloudFormation execution policy (worklog,
// 2026-11-24, policy size): the policy tests pinned every action, resource and condition, but not the
// size IAM measures after CloudFormation has resolved the template. These tests resolve each document
// with the longest values the account could give it and assert the documented limits:
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXECUTION_POLICY_PARTS } from './bootstrapStack.ts'
import { NAMES } from './names.ts'
import { ofType, resources, synth, type Resource, type Statement } from './testApp.ts'
import { LONGEST_REPOSITORY, resolver, size, type Json } from './testPolicySize.ts'

// IAM counts characters without whitespace.
const MANAGED_POLICY_MAX = 6_144
const ROLE_INLINE_POLICIES_MAX = 10_240
const ROLE_MANAGED_POLICIES_MAX = 10
const ROLE_TRUST_POLICY_MAX = 2_048
// CloudFormation, per template.
const TEMPLATE_RESOURCES_MAX = 500
const TEMPLATE_OUTPUTS_MAX = 200
const TEMPLATE_PARAMETERS_MAX = 200

const { templates } = synth({ githubRepository: LONGEST_REPOSITORY })
const stacks = Object.entries(templates)
const document = (resource: Resource) => resource.Properties?.PolicyDocument as Json

describe('IAM and CloudFormation quotas, on worst-case values', () => {
  it('every managed policy (the execution parts and the boundary included) fits IAM’s 6,144 characters', () => {
    let checked = 0
    for (const [stack, template] of stacks) {
      const resolve = resolver(resources(template))
      for (const [id, policy] of ofType(template, 'AWS::IAM::ManagedPolicy')) {
        expect(size(resolve(document(policy))), `${stack} ${id}`).toBeLessThanOrEqual(MANAGED_POLICY_MAX)
        checked++
      }
    }
    expect(checked).toBe(EXECUTION_POLICY_PARTS.length + 1)
  })

  it('every role: inline policies together within 10,240 characters, at most 10 managed policies, trust policy within 2,048', () => {
    for (const [stack, template] of stacks) {
      const all = resources(template)
      const resolve = resolver(all)
      for (const [roleId, role] of ofType(template, 'AWS::IAM::Role')) {
        const attached = ofType(template, 'AWS::IAM::Policy').filter(([, policy]) =>
          (policy.Properties?.Roles as Json[]).some((r) => JSON.stringify(r) === JSON.stringify({ Ref: roleId })),
        )
        const own = (role.Properties?.Policies as { PolicyDocument: Json }[] | undefined) ?? []
        const inline =
          attached.reduce((sum, [, policy]) => sum + size(resolve(document(policy))), 0) +
          own.reduce((sum, policy) => sum + size(resolve(policy.PolicyDocument)), 0)
        expect(inline, `${stack} ${roleId} inline`).toBeLessThanOrEqual(ROLE_INLINE_POLICIES_MAX)
        const managed = (role.Properties?.ManagedPolicyArns as Json[] | undefined) ?? []
        expect(managed.length, `${stack} ${roleId} managed`).toBeLessThanOrEqual(ROLE_MANAGED_POLICIES_MAX)
        const trust = size(resolve(role.Properties?.AssumeRolePolicyDocument as Json))
        expect(trust, `${stack} ${roleId} trust`).toBeLessThanOrEqual(ROLE_TRUST_POLICY_MAX)
      }
    }
  })

  it('every template stays within CloudFormation’s resource, output and parameter counts', () => {
    for (const [stack, template] of stacks) {
      const json = template.toJSON() as Record<string, Record<string, unknown> | undefined>
      expect(Object.keys(json.Resources ?? {}).length, stack).toBeLessThanOrEqual(TEMPLATE_RESOURCES_MAX)
      expect(Object.keys(json.Outputs ?? {}).length, stack).toBeLessThanOrEqual(TEMPLATE_OUTPUTS_MAX)
      expect(Object.keys(json.Parameters ?? {}).length, stack).toBeLessThanOrEqual(TEMPLATE_PARAMETERS_MAX)
    }
  })
})

describe('the CloudFormation execution policy, split by size', () => {
  const bootstrap = templates.bootstrap
  const parts = ofType(bootstrap, 'AWS::IAM::ManagedPolicy').filter(([, policy]) =>
    String(policy.Properties?.ManagedPolicyName).startsWith(`${NAMES.cfnExecutionPolicy}-`),
  )
  const statementsOf = (policy: Resource) => (document(policy) as { Statement: Statement[] }).Statement

  it('the execution role holds exactly the parts, and nothing else', () => {
    expect(parts.map(([, policy]) => policy.Properties?.ManagedPolicyName).sort()).toEqual(
      EXECUTION_POLICY_PARTS.map((part) => `${NAMES.cfnExecutionPolicy}-${part}`).sort(),
    )
    const [, role] = ofType(bootstrap, 'AWS::IAM::Role').find(
      ([, r]) => r.Properties?.RoleName === NAMES.cfnExecutionRole,
    ) as [string, Resource]
    expect(role.Properties?.ManagedPolicyArns).toEqual(parts.map(([id]) => ({ Ref: id })))
  })

  it('the parts together hold exactly the statements of the single policy before the split, none dropped, widened or repeated', () => {
    const before = JSON.parse(
      readFileSync(new URL('./cfnExecutionStatements.json', import.meta.url), 'utf8'),
    ) as Statement[]
    const union = parts.flatMap(([, policy]) => statementsOf(policy))
    const bySid = (a: Statement, b: Statement) => String(a.Sid).localeCompare(String(b.Sid))
    expect(new Set(union.map((s) => s.Sid)).size).toBe(union.length)
    expect([...union].sort(bySid)).toEqual([...before].sort(bySid))
  })
})
