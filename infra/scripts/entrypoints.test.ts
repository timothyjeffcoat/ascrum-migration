// O4 / DEV-p5-infra-09: the destroy and leftover steps run exactly as the workflows run them: each
// step's own `run:` text from the workflow file, in bash with GitHub's flags (-eo pipefail), from the
// repository root, with a fake `aws` first on PATH. So a `|| true` in a step, a main block that catches
// and exits 0, or a leftover check that always exits 0 turns these tests red.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, step, WORKFLOW_FILES } from './workflowFiles.ts'

type Rule = { match: string; code?: number; stdout?: unknown; stderr?: string }

const DESTROY_STEP = 'AC-AWS-04 destroy everything this run created'
const DESTROY_STEP_MANUAL = 'AC-AWS-04 destroy the demo stacks (nothing to do if they do not exist)'
const LEFTOVER_STEP = 'AC-AWS-04 nothing remains but the bootstrap and the budget'

const STEPS = {
  'deploy-demo.yml destroy': step(WORKFLOW_FILES.deploy, 'destroy', DESTROY_STEP),
  'destroy-demo.yml destroy': step(WORKFLOW_FILES.destroy, 'destroy', DESTROY_STEP_MANUAL),
  'deploy-demo.yml leftovers': step(WORKFLOW_FILES.deploy, 'destroy', LEFTOVER_STEP),
  'destroy-demo.yml leftovers': step(WORKFLOW_FILES.destroy, 'destroy', LEFTOVER_STEP),
}

const bin = mkdtempSync(join(tmpdir(), 'ascrum-fake-aws-'))
const fakeBin = fileURLToPath(new URL('./fakeAwsBin.ts', import.meta.url))
writeFileSync(join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`)
chmodSync(join(bin, 'aws'), 0o755)
// The leftover step tees into infra/evidence, which the destroy step before it creates (git-ignored).
mkdirSync(join(REPO_ROOT, 'infra', 'evidence'), { recursive: true })

function runStep(script: string | undefined, rules: Rule[]) {
  if (!script) throw new Error('step has no run:')
  const log = join(mkdtempSync(join(tmpdir(), 'ascrum-fake-aws-log-')), 'calls.txt')
  writeFileSync(log, '')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${join(process.execPath, '..')}:/usr/bin:/bin`,
      AWS_REGION: 'eu-west-1',
      FAKE_AWS_RULES: JSON.stringify(rules),
      FAKE_AWS_LOG: log,
      // Never a real credential (spec §11).
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_CONFIG_FILE: '/dev/null',
    },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: readFileSync(log, 'utf8') }
}

const absent: Rule = {
  match: 'cloudformation describe-stacks',
  code: 254,
  stderr:
    'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id AscrumDemo does not exist',
}
const nothingTagged: Rule = { match: 'resourcegroupstaggingapi get-resources', stdout: { ResourceTagMappingList: [] } }
const cannotDelete: Rule[] = [
  {
    match: 'cloudformation describe-stacks --stack-name AscrumDemo ',
    stdout: { Stacks: [{ StackStatus: 'DELETE_FAILED' }] },
  },
  { match: 'cloudformation list-stack-resources', stdout: { StackResourceSummaries: [] } },
  { match: 'cloudformation delete-stack' },
  { match: 'cloudformation describe-stack-events', stdout: { StackEvents: [] } },
]

describe('AC-AWS-04 / O4: the destroy step, as the workflows run it', () => {
  for (const name of ['deploy-demo.yml destroy', 'destroy-demo.yml destroy'] as const) {
    it(`AC-AWS-04 / O4 (c): ${name}: a stack that cannot be deleted fails the step`, () => {
      const { status, output, calls } = runStep(STEPS[name].run, cannotDelete)
      expect(status, output).not.toBe(0)
      expect(output).toContain('AscrumDemo could not be deleted (DELETE_FAILED)')
      expect(calls.match(/delete-stack --stack-name AscrumDemo /g)).toHaveLength(2)
    })

    it(`AC-AWS-04: ${name}: nothing deployed: the step passes and deletes nothing`, () => {
      const { status, output, calls } = runStep(STEPS[name].run, [absent])
      expect(status, output).toBe(0)
      expect(output).toContain('deleted: none; already absent: AscrumDemo, AscrumDemoRegistry')
      expect(calls).not.toContain('delete-stack')
    })

    it(`AC-AWS-04 (S22): ${name}: an AccessDenied on describe-stacks fails the step`, () => {
      const denied: Rule = {
        match: 'cloudformation describe-stacks',
        code: 254,
        stderr: 'An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized',
      }
      const { status, output } = runStep(STEPS[name].run, [denied])
      expect(status, output).not.toBe(0)
    })
  }
})

describe('AC-AWS-04 / O4: the leftover step, as the workflows run it', () => {
  for (const name of ['deploy-demo.yml leftovers', 'destroy-demo.yml leftovers'] as const) {
    it(`AC-AWS-04 / O4 (d): ${name}: a demo stack still standing fails the step`, () => {
      const rules: Rule[] = [
        {
          match: 'cloudformation describe-stacks --stack-name AscrumDemo ',
          stdout: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
        },
        absent,
        nothingTagged,
      ]
      const { status, output } = runStep(STEPS[name].run, rules)
      expect(status, output).toBe(1)
      expect(output).toContain('Demo stacks still present: AscrumDemo (CREATE_COMPLETE)')
      expect(output).toContain('FAILED: demo resources remain (AC-AWS-04).')
    })

    it(`AC-AWS-04: ${name}: nothing left: the step passes with the OK line`, () => {
      const { status, output, calls } = runStep(STEPS[name].run, [absent, nothingTagged])
      expect(status, output).toBe(0)
      expect(output).toContain('OK: nothing from the demo remains.')
      expect(calls).toContain('get-resources --region eu-west-1 ')
      expect(calls).toContain('get-resources --region us-east-1 ')
    })

    it(`AC-AWS-04 (S20): ${name}: a failed get-resources fails the step`, () => {
      const failed: Rule = {
        match: 'resourcegroupstaggingapi get-resources',
        code: 254,
        stderr: 'An error occurred (AccessDeniedException) when calling the GetResources operation',
      }
      const { status, output } = runStep(STEPS[name].run, [absent, failed])
      expect(status, output).not.toBe(0)
    })
  }
})
