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
import { liveAnswers, liveContainer, TAG } from './fakeTaskDefinition.ts'
import { REPO_ROOT, step, WORKFLOW_FILES } from './workflowFiles.ts'

type Rule = { match: string; code?: number; stdout?: unknown; stdoutRaw?: string; stderr?: string }

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

function runStep(
  script: string | undefined,
  rules: Rule[],
  extra: { env?: Record<string, string>; cwd?: string } = {},
) {
  if (!script) throw new Error('step has no run:')
  const log = join(mkdtempSync(join(tmpdir(), 'ascrum-fake-aws-log-')), 'calls.txt')
  writeFileSync(log, '')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: extra.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...extra.env,
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

// sec-05 / DEV-p5-infra-41: an error must not put raw AWS stderr (an account id in a role ARN, more lines, a
// stack trace) into the log or the tee'd evidence artifact. Each script's main block prints one cleaned
// line and exits non-zero.
const ACCOUNT_ID = '123456789012'
const refusedStderr = (operation: string) =>
  `An error occurred (AccessDeniedException) when calling the ${operation} operation: User: arn:aws:sts::${ACCOUNT_ID}:assumed-role/ascrum-github-deploy/GitHubActions is not authorized\nsecond line 210987654321\n`
function expectClean(status: number | null, output: string, mustContain: string) {
  expect(status, output).not.toBe(0)
  expect(output).toContain(mustContain)
  expect(output).not.toMatch(/\b\d{12}\b/)
  expect(output).not.toContain('second line')
  expect(output).not.toMatch(/^\s+at /m) // no stack trace
}

describe('sec-07 / DEV-p5-infra-43: workflow-command data and the remaining guards, as the workflows run the scripts', () => {
  it('sec-07: a "%0A" in AWS text reaches the ::error:: line escaped as "%250A" (runMain)', () => {
    const denied: Rule = {
      match: 'resourcegroupstaggingapi get-resources',
      code: 254,
      stderr: 'An error occurred (AccessDeniedException) %0AOK: x',
    }
    const { status, output } = runStep(STEPS['deploy-demo.yml leftovers'].run, [absent, denied])
    expect(status, output).toBe(1)
    expect(output).toContain(
      '::error::get-resources in eu-west-1 failed: An error occurred (AccessDeniedException) %250AOK: x',
    )
    expect(output).not.toMatch(/%0A/)
  })

  it('Q4/Q10: a stack event reason with an account id and a newline reaches neither the output nor destroy.txt', () => {
    const rules: Rule[] = [
      ...cannotDelete.filter((rule) => rule.match !== 'cloudformation describe-stack-events'),
      {
        match: 'cloudformation describe-stack-events',
        stdout: {
          StackEvents: [
            {
              LogicalResourceId: 'WebBucket',
              ResourceStatus: 'DELETE_FAILED',
              ResourceStatusReason: `User: arn:aws:sts::${ACCOUNT_ID}:assumed-role/ascrum-cfn-exec/AWSCloudFormation is not authorized\nsecond line`,
            },
          ],
        },
      },
    ]
    for (const name of ['deploy-demo.yml destroy', 'destroy-demo.yml destroy'] as const) {
      const { status, output } = runStep(STEPS[name].run, rules)
      expect(status, output).toBe(1)
      expect(output).toContain('WebBucket: DELETE_FAILED User: arn:aws:sts::***:assumed-role')
      const evidence = readFileSync(join(REPO_ROOT, 'infra', 'evidence', 'destroy.txt'), 'utf8')
      for (const text of [output, evidence]) {
        expect(text).not.toMatch(/\b\d{12}\b/)
        expect(text).not.toMatch(/^second line/m)
      }
    }
  })

  it('Q1/Q02: an answer that is not JSON, quoted by the parse error, is cleaned by runMain; the step exits 1', () => {
    const garbled: Rule = {
      match: 'cloudformation describe-stacks',
      // Short enough that V8 quotes all of it in the SyntaxError (a longer answer is cut after 10 characters).
      stdoutRaw: `<${ACCOUNT_ID}\u001b[2J`,
    }
    for (const name of ['deploy-demo.yml leftovers', 'deploy-demo.yml destroy'] as const) {
      const { status, output } = runStep(STEPS[name].run, [garbled])
      expect(status, output).toBe(1)
      // The cleaned quote proves the account id and the ESC reached runMain and were removed there.
      expect(output).toContain(`::error::Unexpected token '<', "<*** [2J" is not valid JSON`)
      expect(output).not.toMatch(/\b\d{12}\b/)
      expect(output).not.toContain('\u001b')
    }
  })
})

describe('sec-05: a failing AWS call prints one cleaned line, as the workflows run the scripts', () => {
  const deniedStacks: Rule = {
    match: 'cloudformation describe-stacks',
    code: 254,
    stderr: refusedStderr('DescribeStacks'),
  }
  for (const name of ['deploy-demo.yml leftovers', 'destroy-demo.yml leftovers'] as const) {
    it(`sec-05: ${name}: a refused get-resources prints no account id, no second line and no stack, and fails`, () => {
      const denied: Rule = {
        match: 'resourcegroupstaggingapi get-resources',
        code: 254,
        stderr: refusedStderr('GetResources'),
      }
      const { status, output } = runStep(STEPS[name].run, [absent, denied])
      expectClean(status, output, 'get-resources in eu-west-1 failed: An error occurred (AccessDeniedException)')
      const evidence = readFileSync(join(REPO_ROOT, 'infra', 'evidence', 'leftovers.txt'), 'utf8')
      expect(evidence).not.toMatch(/\b\d{12}\b/)
      expect(evidence).not.toContain('second line')
    })

    it(`sec-05: ${name}: a refused describe-stacks (through aws.ts) prints one cleaned line, and fails`, () => {
      const { status, output } = runStep(STEPS[name].run, [deniedStacks])
      expectClean(status, output, 'describe-stacks AscrumDemo failed: An error occurred (AccessDeniedException)')
    })
  }

  for (const name of ['deploy-demo.yml destroy', 'destroy-demo.yml destroy'] as const) {
    it(`sec-05: ${name}: a refused describe-stacks prints one cleaned line, and fails`, () => {
      const { status, output } = runStep(STEPS[name].run, [deniedStacks])
      expectClean(status, output, 'describe-stacks AscrumDemo failed: An error occurred (AccessDeniedException)')
    })

    it(`sec-05: ${name}: a refused s3 rm prints one cleaned line, and fails`, () => {
      const rules: Rule[] = [
        {
          match: 'cloudformation describe-stacks --stack-name AscrumDemo ',
          stdout: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
        },
        {
          match: 'cloudformation list-stack-resources',
          stdout: {
            StackResourceSummaries: [
              { ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'web-bucket', ResourceStatus: 'CREATE_COMPLETE' },
            ],
          },
        },
        { match: 's3 rm', code: 1, stderr: refusedStderr('ListObjectsV2') },
      ]
      const { status, output, calls } = runStep(STEPS[name].run, rules)
      expectClean(status, output, 'emptying s3://web-bucket failed: An error occurred (AccessDeniedException)')
      expect(calls).not.toContain('delete-stack')
    })
  }
})

// spec §6 image-scan, as the deploy job runs it (live run 1: ScanNotFoundException right after the push).
describe('spec §6 image-scan: the scan step, as the workflow runs it', () => {
  const scanStep = step(
    WORKFLOW_FILES.deploy,
    'deploy',
    'image-scan (spec §6, Q-p5-7) no HIGH or CRITICAL finding in the API image',
  )
  const evidence = mkdtempSync(join(tmpdir(), 'ascrum-scan-evidence-'))
  const env = { IMAGE_TAG: 'abc123', EVIDENCE: evidence, IMAGE_SCAN_POLL_MS: '1' }
  const DIGEST = 'sha256:' + 'b'.repeat(64)
  const scan = (status: string, counts: Record<string, number> = {}): Rule => ({
    match: `ecr describe-image-scan-findings --repository-name ascrum-demo-api --image-id imageDigest=${DIGEST} `,
    stdout: { imageScanStatus: { status }, imageScanFindings: { findingSeverityCounts: counts, findings: [] } },
  })
  const described = (imageManifestMediaType: string): Rule => ({
    match: 'ecr describe-images --repository-name ascrum-demo-api --image-ids imageTag=abc123 ',
    stdout: { imageDetails: [{ imageDigest: DIGEST, imageManifestMediaType }] },
  })
  const single = described('application/vnd.oci.image.manifest.v1+json')
  const notFound: Rule = {
    match: 'ecr describe-image-scan-findings',
    code: 254,
    stderr:
      'An error occurred (ScanNotFoundException) when calling the DescribeImageScanFindings operation: Image scan does not exist',
  }

  it('image-scan: a completed clean scan passes and is written to the evidence', () => {
    const { status, output, calls } = runStep(scanStep.run, [single, scan('COMPLETE', { LOW: 1 })], { env })
    expect(status, output).toBe(0)
    expect(calls).not.toContain('start-image-scan')
    expect(JSON.parse(readFileSync(join(evidence, 'image-scan.json'), 'utf8'))).toMatchObject({
      status: 'COMPLETE',
      counts: { LOW: 1 },
    })
  })

  it('image-scan: a HIGH or CRITICAL finding fails the step', () => {
    for (const counts of [{ HIGH: 1 }, { CRITICAL: 1 }] as Record<string, number>[]) {
      const { status, output } = runStep(scanStep.run, [single, scan('COMPLETE', counts)], { env })
      expect(status, output).toBe(1)
      expect(output).toContain('HIGH or CRITICAL findings')
    }
  })

  it('image-scan (live run 1): no scan at all: the step starts one, and fails when it never shows up', () => {
    const { status, output, calls } = runStep(scanStep.run, [single, notFound, { match: 'ecr start-image-scan' }], {
      env,
    })
    expect(status, output).toBe(1)
    expect(calls).toContain(`ecr start-image-scan --repository-name ascrum-demo-api --image-id imageDigest=${DIGEST} `)
    expect(output).toContain('did not complete (NOT_FOUND)')
  })

  it('sec-05: image-scan: a refused start-image-scan prints one cleaned line, and fails', () => {
    const refused: Rule = { match: 'ecr start-image-scan', code: 254, stderr: refusedStderr('StartImageScan') }
    const { status, output } = runStep(scanStep.run, [single, notFound, refused], { env })
    expectClean(status, output, 'start-image-scan failed: An error occurred (AccessDeniedException)')
  })

  it('sec-07: image-scan: a "%0A" in the scan status reaches the ::error:: verdict escaped as "%250A"', () => {
    const { status, output } = runStep(scanStep.run, [single, scan('FAILED%0AOK: x')], { env })
    expect(status, output).toBe(1)
    expect(output).toContain('::error::The image scan did not complete (FAILED%250AOK: x)')
    // Only workflow-command lines are decoded by the runner; the plain "scan …" log line is not one.
    expect(output.split('\n').filter((line) => line.startsWith('::') && line.includes('%0A'))).toEqual([])
  })

  it('image-scan: a refused start-image-scan fails the step', () => {
    const refused: Rule = {
      match: 'ecr start-image-scan',
      code: 254,
      stderr: 'An error occurred (AccessDeniedException)',
    }
    const { status, output } = runStep(scanStep.run, [single, notFound, refused], { env })
    expect(status, output).not.toBe(0)
  })

  it('image-scan (live run 2): an OCI image index under the tag fails the step and is named in the evidence', () => {
    const index = described('application/vnd.oci.image.index.v1+json')
    const { status, output, calls } = runStep(scanStep.run, [index, scan('COMPLETE')], { env })
    expect(status, output).toBe(1)
    expect(output).toContain('did not complete (UNSCANNABLE_MEDIA_TYPE)')
    expect(calls).not.toContain('describe-image-scan-findings')
    expect(calls).not.toContain('start-image-scan')
    expect(JSON.parse(readFileSync(join(evidence, 'image-scan.json'), 'utf8'))).toMatchObject({
      status: 'UNSCANNABLE_MEDIA_TYPE',
      mediaType: 'application/vnd.oci.image.index.v1+json',
    })
  })
})

// Live run 10's caveat, as the deploy job runs it: the step's own run text with a fake `aws` on PATH.
describe('live run 10: the live task definition step, as the workflow runs it', () => {
  const taskStep = step(
    WORKFLOW_FILES.deploy,
    'deploy',
    'The live task definition drops every capability, runs init and user 1000:1000',
  )
  const rules = (answers = liveAnswers()): Rule[] => [
    { match: 'cloudformation list-stack-resources --stack-name AscrumDemo ', stdout: answers.resources },
    { match: 'ecs describe-services --cluster ascrum-demo --services ', stdout: answers.services },
    { match: 'ecs describe-task-definition --task-definition ', stdout: answers.taskDefinition },
  ]
  const run = (stepRules: Rule[]) => {
    const evidence = mkdtempSync(join(tmpdir(), 'ascrum-task-evidence-'))
    const result = runStep(taskStep.run, stepRules, { env: { IMAGE_TAG: TAG, EVIDENCE: evidence } })
    return { ...result, file: readFileSync(join(evidence, 'task-definition.json'), 'utf8') }
  }

  it("live run 10: AWS's matching copy passes and is kept, without the environment, the secrets or an account id", () => {
    const { status, output, file } = run(rules())
    expect(status, output).toBe(0)
    expect(output).toContain('live task definition ascrum-demo-api:7: user 1000:1000, capabilities drop ALL')
    const record = JSON.parse(file) as { container: Record<string, unknown> }
    expect(record.container).toMatchObject({
      user: '1000:1000',
      readonlyRootFilesystem: true,
      linuxParameters: { capabilities: { add: [], drop: ['ALL'] }, initProcessEnabled: true },
    })
    expect(file).not.toMatch(/\b\d{12}\b/)
    expect(file).not.toMatch(/environment|secrets|DB_PASSWORD|never-kept/)
  })

  it('live run 10: a copy without the capability drop, the init process or the user fails the step and is still kept', () => {
    const bad = liveContainer({ user: '0', linuxParameters: { capabilities: { drop: [] }, initProcessEnabled: false } })
    const { status, output, file } = run(rules(liveAnswers(bad)))
    expect(status, output).toBe(1)
    expect(output).toContain('::error::live task definition ascrum-demo-api:7: user is 0, not 1000:1000')
    expect(output).toContain(
      '::error::live task definition ascrum-demo-api:7: capabilities.drop is not exactly ["ALL"]',
    )
    expect(output).toContain('::error::live task definition ascrum-demo-api:7: initProcessEnabled is not true')
    expect(JSON.parse(file)).toMatchObject({ container: { user: '0' } })
  })

  it('sec-05: a refused describe-services fails the step with one cleaned line, and the evidence says why', () => {
    const refused: Rule = {
      match: 'ecs describe-services',
      code: 254,
      stderr: refusedStderr('DescribeServices'),
    }
    const [resources, , definition] = rules()
    const { status, output, file } = run([resources as Rule, refused, definition as Rule])
    expectClean(status, output, 'describe-services --cluster ascrum-demo --services')
    expect(output).toContain('AccessDeniedException')
    expect(output).not.toContain('describe-task-definition')
    expect(JSON.parse(file)).toMatchObject({ error: expect.stringContaining('AccessDeniedException') })
    expect(file).not.toMatch(/\b\d{12}\b/)
    expect(file).not.toContain('second line')
  })
})

// AC-AWS-07, as the evidence job runs it (live run 1: download-artifact could not find destroy-evidence by
// its id seconds after it was uploaded). A stand-in `gh` fails each artifact's first N downloads.
describe('AC-AWS-07: the evidence steps, as the workflow runs them', () => {
  const collect = step(WORKFLOW_FILES.deploy, 'evidence', 'AC-AWS-07 collect the deploy and destroy evidence (retried)')
  const check = step(WORKFLOW_FILES.deploy, 'evidence', 'AC-AWS-07 every part of the evidence is in it')
  const ghBin = mkdtempSync(join(tmpdir(), 'ascrum-stand-in-gh-'))
  writeFileSync(
    join(ghBin, 'gh'),
    [
      '#!/bin/bash',
      'while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift;; --dir) dir=$2; shift;; esac; shift; done',
      'echo "$name" >> "$STANDIN_GH_LOG"',
      'count=$(grep -cx "$name" "$STANDIN_GH_LOG")',
      'fails=$(printf "%s" "$STANDIN_GH_FAILS" | tr "," "\\n" | grep "^$name=" | cut -d= -f2)',
      'if [ "$count" -le "${fails:-0}" ]; then echo "stand-in gh: no artifact $name" >&2; exit 1; fi',
      'mkdir -p "$dir" && echo ok > "$dir/$name.txt"',
    ].join('\n'),
  )
  chmodSync(join(ghBin, 'gh'), 0o755)

  function evidenceJob(fails: string, results = { deploy: 'failure', destroy: 'success' }) {
    const dir = mkdtempSync(join(tmpdir(), 'ascrum-evidence-job-'))
    const env = {
      PATH: `${ghBin}:/usr/bin:/bin`,
      STANDIN_GH_LOG: join(dir, 'gh.log'),
      STANDIN_GH_FAILS: fails,
      EVIDENCE_RETRY_SECONDS: '0',
      GITHUB_RUN_ID: '1',
      GITHUB_REPOSITORY: 'example-owner/ascrum-migration',
      DEPLOY_RESULT: results.deploy,
      DESTROY_RESULT: results.destroy,
    }
    writeFileSync(env.STANDIN_GH_LOG, '')
    const run = (script: string | undefined) =>
      spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script ?? 'exit 99'], {
        cwd: dir,
        encoding: 'utf8',
        env,
      })
    const collected = run(collect.run)
    const checked = run(check.run)
    const has = (name: string) => spawnSync('test', ['-f', join(dir, 'evidence', name, `${name}.txt`)]).status === 0
    return { collected, checked, has, log: readFileSync(env.STANDIN_GH_LOG, 'utf8'), dir }
  }

  it('AC-AWS-07 (live run 1): a transient failure is retried; both parts arrive and the check passes', () => {
    const { collected, checked, has, log } = evidenceJob('destroy-evidence=2')
    expect(collected.status, collected.stderr).toBe(0)
    expect(has('deploy-evidence') && has('destroy-evidence')).toBe(true)
    expect(log.match(/^destroy-evidence$/gm)).toHaveLength(3)
    expect(checked.status, checked.stdout).toBe(0)
  })

  it('AC-AWS-07: a part that never arrives is named in MISSING.txt, the rest is kept, and the check fails', () => {
    const { collected, checked, has, dir } = evidenceJob('destroy-evidence=9')
    expect(collected.status).toBe(0) // the artifact is still uploaded with what arrived
    expect(has('deploy-evidence')).toBe(true)
    expect(readFileSync(join(dir, 'evidence', 'MISSING.txt'), 'utf8')).toBe('destroy-evidence\n')
    expect(checked.status).toBe(1)
    expect(checked.stdout).toContain('The evidence artifact lacks: destroy-evidence')
  })

  it('AC-AWS-07: a job that did not run is not expected', () => {
    const { collected, checked, log } = evidenceJob('', { deploy: 'skipped', destroy: 'success' })
    expect(collected.status).toBe(0)
    expect(log).toBe('destroy-evidence\n')
    expect(checked.status).toBe(0)
  })
})
