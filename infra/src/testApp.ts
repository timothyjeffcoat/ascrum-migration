// Test helper: the app as the CLI builds it (cdk.json's feature flags), with test context, synthesised
// without an AWS account or credentials.
import { readFileSync } from 'node:fs'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import type { CloudAssembly } from 'aws-cdk-lib/cx-api'
import { buildStacks, type AscrumStacks } from './app.ts'

export const TEST_REPOSITORY = 'example-owner/ascrum-migration'

const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>
}

export function synth(context: Record<string, unknown> = {}): {
  stacks: AscrumStacks
  templates: Record<keyof AscrumStacks, Template>
  assembly: CloudAssembly
} {
  const app = new App({ context: { ...cdkJson.context, githubRepository: TEST_REPOSITORY, ...context } })
  const stacks = buildStacks(app, {})
  return {
    stacks,
    assembly: app.synth(),
    templates: {
      bootstrap: Template.fromStack(stacks.bootstrap),
      registry: Template.fromStack(stacks.registry),
      demo: Template.fromStack(stacks.demo),
    },
  }
}

export type Resource = {
  Type: string
  Properties?: Record<string, unknown>
  DeletionPolicy?: string
  UpdateReplacePolicy?: string
}

export function resources(template: Template): Record<string, Resource> {
  return (template.toJSON() as { Resources: Record<string, Resource> }).Resources
}

export function ofType(template: Template, type: string): [string, Resource][] {
  return Object.entries(resources(template)).filter(([, resource]) => resource.Type === type)
}

export type Statement = {
  Sid?: string
  Effect: string
  Action: string | string[]
  Resource?: unknown
  Condition?: Record<string, Record<string, unknown>>
}

export const actionsOf = (statement: Statement): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action]
