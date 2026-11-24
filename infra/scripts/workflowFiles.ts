// Test helper: the two AWS workflow files, parsed, with typed access to their jobs and steps.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../src/testYaml.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  'continue-on-error'?: unknown
  'working-directory'?: string
}
export type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  environment?: unknown
  permissions?: Record<string, string>
  steps: Step[]
  'continue-on-error'?: unknown
}
export type Workflow = {
  name: string
  on: Record<string, unknown>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  permissions?: Record<string, string>
  defaults?: { run?: { shell?: string } }
  jobs: Record<string, Job>
}

export const WORKFLOW_FILES = {
  deploy: '.github/workflows/deploy-demo.yml',
  destroy: '.github/workflows/destroy-demo.yml',
} as const

export function workflowText(file: string): string {
  return readFileSync(new URL(file, new URL('../../', import.meta.url)), 'utf8')
}

export function workflow(file: string): Workflow {
  return parseYaml(workflowText(file)) as Workflow
}

export function job(file: string, id: string): Job {
  const found = workflow(file).jobs[id]
  if (!found) throw new Error(`${file}: no job ${id}`)
  return found
}

export function step(file: string, jobId: string, name: string): Step {
  const found = job(file, jobId).steps.find((s) => s.name === name)
  if (!found) throw new Error(`${file}: job ${jobId} has no step "${name}"`)
  return found
}
