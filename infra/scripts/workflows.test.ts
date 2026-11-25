// AC-AWS-01, -02, -04 and the image-scan gate, as the two workflow files state them (DEV-p5-infra-03,
// DEV-p5-infra-09): triggers, refs, the gate, environments, OIDC, the destroy job's condition, and the
// absence of anything that turns a failure green. The deploy role's trust (bootstrapStack.ts) names these
// two files; these tests pin what the files themselves do.
import { describe, expect, it } from 'vitest'
import { job, step, workflow, WORKFLOW_FILES, workflowText, type Step } from './workflowFiles.ts'

const DEPLOY = WORKFLOW_FILES.deploy
const DESTROY = WORKFLOW_FILES.destroy
const ON_MIGRATION_ONLY = "github.ref != 'refs/heads/migration'"
const CREDENTIALS = /^aws-actions\/configure-aws-credentials@[0-9a-f]{40}$/

const steps = (file: string): [string, Step][] =>
  Object.entries(workflow(file).jobs).flatMap(([id, j]) => j.steps.map((s): [string, Step] => [id, s]))

function refusesOtherRefs(first: Step | undefined) {
  expect(first?.if).toBe(ON_MIGRATION_ONLY)
  expect(first?.run).toMatch(/\bexit 1\s*$/)
}

function destroyAndLeftoverSteps(file: string, destroyStepName: string) {
  const destroyJob = job(file, 'destroy')
  const names = destroyJob.steps.map((s) => s.name)
  const destroyStep = step(file, 'destroy', destroyStepName)
  expect(destroyStep.if).toBeUndefined()
  expect(destroyStep.run).toContain('node infra/scripts/destroy.ts 2>&1 | tee infra/evidence/destroy.txt')
  expect(destroyStep.run).not.toMatch(/\|\||;\s*true|exit 0|set \+e/)
  const leftover = destroyJob.steps.find((s) => s.name === 'AC-AWS-04 nothing remains but the bootstrap and the budget')
  expect(leftover?.if).toBe('always()')
  expect(leftover?.run).toBe('node infra/scripts/leftovers.ts 2>&1 | tee infra/evidence/leftovers.txt')
  expect(names.indexOf(leftover?.name)).toBeGreaterThan(names.indexOf(destroyStep.name))
}

describe('AC-AWS-01: when a deploy may start', () => {
  it('AC-AWS-01 (W01): both workflows start by hand only: no push, pull request, schedule or other trigger', () => {
    expect(Object.keys(workflow(DEPLOY).on)).toEqual(['workflow_dispatch'])
    expect(Object.keys(workflow(DESTROY).on)).toEqual(['workflow_dispatch'])
  })

  it('AC-AWS-01 (W03): each refuses any ref but migration as its first step', () => {
    refusesOtherRefs(job(DEPLOY, 'gate').steps[0])
    refusesOtherRefs(job(DESTROY, 'destroy').steps[0])
  })

  it('AC-AWS-01 (W04): the gate runs the required-check script on migration, and nothing can mask its exit code', () => {
    const gate = step(DEPLOY, 'gate', 'AC-AWS-01 every required check passed on this commit')
    expect(gate.run?.trim()).toBe('node infra/scripts/requiredChecks.ts migration')
    expect(gate.if).toBeUndefined()
    const deploy = job(DEPLOY, 'deploy')
    expect(deploy.needs).toBe('gate')
    expect(deploy.if).toBeUndefined()
  })

  it('AC-AWS-01: one AWS run at a time, never cancelled by the next; bash with -eo pipefail', () => {
    for (const file of [DEPLOY, DESTROY]) {
      expect(workflow(file).concurrency, file).toEqual({ group: 'aws-demo', 'cancel-in-progress': false })
      expect(workflow(file).defaults?.run?.shell, file).toBe('bash')
      expect(workflow(file).permissions, file).toEqual({ contents: 'read' })
    }
  })
})

describe('AC-AWS-02: AWS credentials through OIDC only', () => {
  it('AC-AWS-02 (W06): every job that can get an OIDC token runs in the aws-demo environment, and only those', () => {
    const withToken: string[] = []
    for (const file of [DEPLOY, DESTROY]) {
      for (const [id, j] of Object.entries(workflow(file).jobs)) {
        if (j.permissions?.['id-token'] === undefined) continue
        withToken.push(`${file}#${id}`)
        expect(j.permissions['id-token'], id).toBe('write')
        expect(j.environment, id).toBe('aws-demo')
      }
    }
    expect(withToken).toEqual([`${DEPLOY}#deploy`, `${DEPLOY}#destroy`, `${DESTROY}#destroy`])
    expect(job(DEPLOY, 'gate').permissions?.['id-token']).toBeUndefined()
    expect(job(DEPLOY, 'evidence').permissions?.['id-token']).toBeUndefined()
  })

  it('AC-AWS-02 (W08): credentials come from the deploy role only, through a SHA-pinned action; no stored key anywhere', () => {
    for (const file of [DEPLOY, DESTROY]) {
      const credentialSteps = steps(file).filter(([, s]) => s.uses?.startsWith('aws-actions/configure-aws-credentials'))
      expect(credentialSteps.length, file).toBeGreaterThan(0)
      for (const [id, s] of credentialSteps) {
        expect(s.uses, id).toMatch(CREDENTIALS)
        expect(Object.keys(s.with ?? {}).sort(), id).toEqual([
          'aws-region',
          'mask-aws-account-id',
          'role-duration-seconds',
          'role-session-name',
          'role-to-assume',
        ])
        expect(s.with?.['role-to-assume'], id).toBe('${{ secrets.AWS_DEPLOY_ROLE_ARN }}')
        expect(s.with?.['mask-aws-account-id'], id).toBe(true)
      }
      const text = workflowText(file)
      for (const key of [
        'aws-access-key-id',
        'aws-secret-access-key',
        'aws-session-token',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ]) {
        expect(text, `${file}: ${key}`).not.toContain(key)
      }
      expect(text, file).not.toContain('cdk bootstrap')
    }
  })
})

describe('spec §6 image-scan: the gate before the service exists', () => {
  it('image-scan (W07): waits for the scan and stops on any HIGH or CRITICAL finding, before the demo stack is deployed', () => {
    const deploy = job(DEPLOY, 'deploy')
    const names = deploy.steps.map((s) => s.name ?? '')
    const scanIndex = names.findIndex((n) => n.startsWith('image-scan'))
    const demoIndex = names.indexOf('Deploy the demo stack (network, database, API, web bucket, CloudFront)')
    const pushIndex = names.indexOf('Push the API image')
    expect(pushIndex).toBeGreaterThanOrEqual(0)
    expect(scanIndex).toBeGreaterThan(pushIndex)
    expect(demoIndex).toBeGreaterThan(scanIndex)
    const scan = deploy.steps[scanIndex] as Step
    expect(scan.if).toBeUndefined()
    // The whole gate is the script (imageScan.test.ts, entrypoints.test.ts), nothing around it.
    expect(scan.run?.trim()).toBe(
      'node infra/scripts/imageScan.ts ascrum-demo-api "$IMAGE_TAG" "$EVIDENCE/image-scan.json"',
    )
    expect(scan.env).toBeUndefined()
    // Only the entry-point tests shorten the poll.
    expect(workflowText(DEPLOY)).not.toContain('IMAGE_SCAN_POLL_MS')
  })

  it('image-scan (live run 2): the API image is built as one linux/amd64 manifest with no attestation index, so ECR can scan it', () => {
    const build = step(DEPLOY, 'deploy', 'Build the API image from this commit')
    expect(build.run?.trim()).toBe(
      'docker build --platform linux/amd64 --provenance=false --sbom=false -f docker/api.Dockerfile -t "$REPOSITORY_URI:$IMAGE_TAG" .',
    )
    // Nothing else builds or pushes an image, and nothing turns attestations back on.
    const text = workflowText(DEPLOY)
    expect(text.match(/docker (buildx )?build /g)).toHaveLength(1)
    expect(text.match(/docker push /g)).toHaveLength(1)
    expect(text).not.toMatch(/--attest|--push\b|BUILDX_NO_DEFAULT_ATTESTATIONS|oci-artifact/)
  })
})

describe('AC-AWS-07: one evidence artifact, complete or visibly not', () => {
  const evidence = () => job(DEPLOY, 'evidence')
  const names = () => evidence().steps.map((s) => s.name ?? s.uses ?? '')

  it('AC-AWS-07 (live run 1): the deploy and destroy evidence are fetched by name with retries, not by one download-artifact call', () => {
    expect(workflowText(DEPLOY)).not.toContain('actions/download-artifact')
    const collect = step(DEPLOY, 'evidence', 'AC-AWS-07 collect the deploy and destroy evidence (retried)')
    expect(names()[0]).toBe(collect.name)
    expect(collect.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      DEPLOY_RESULT: '${{ needs.deploy.result }}',
      DESTROY_RESULT: '${{ needs.destroy.result }}',
    })
    expect(evidence().permissions).toEqual({ actions: 'read' })
  })

  it('AC-AWS-07: the artifact is uploaded whatever happened, and a missing part then fails the job', () => {
    const upload = step(DEPLOY, 'evidence', 'AC-AWS-07 one artifact for the run')
    expect(upload.if).toBe('always()')
    const check = step(DEPLOY, 'evidence', 'AC-AWS-07 every part of the evidence is in it')
    expect(check.if).toBeUndefined()
    expect(names().indexOf(check.name ?? '')).toBe(names().length - 1)
    expect(check.run).toMatch(/if \[ -s evidence\/MISSING\.txt \]; then\n[^\n]*\n\s*exit 1\n\s*fi/)
  })
})

describe('AC-AWS-04 / O4: a run always ends by destroying what it created', () => {
  it('AC-AWS-04 / O4 (a) (W02): destroy runs after any deploy outcome (success, failure, cancel) once the gate passed', () => {
    const destroy = job(DEPLOY, 'destroy')
    expect(destroy.needs).toEqual(['gate', 'deploy'])
    expect(destroy.if).toBe("always() && needs.gate.result == 'success'")
    expect(destroy.environment).toBe('aws-demo')
  })

  it('AC-AWS-04 / O4 (c, d) (W05): destroy, then the leftover check on always(), and neither can be masked', () => {
    destroyAndLeftoverSteps(DEPLOY, 'AC-AWS-04 destroy everything this run created')
    destroyAndLeftoverSteps(DESTROY, 'AC-AWS-04 destroy the demo stacks (nothing to do if they do not exist)')
  })

  it('AC-AWS-04 / O4 (W05): no continue-on-error anywhere in either workflow', () => {
    for (const file of [DEPLOY, DESTROY]) {
      expect(workflowText(file), file).not.toContain('continue-on-error')
      for (const [id, j] of Object.entries(workflow(file).jobs)) expect(j['continue-on-error'], id).toBeUndefined()
    }
  })

  it('AC-AWS-04: "|| true" only where a failure is expected and harmless (the readiness poll, the failed-run evidence), never on a gate, deploy, destroy or check', () => {
    const allowed = [
      `${DEPLOY}#deploy: Wait until the demo answers over HTTPS`,
      `${DEPLOY}#deploy: The API's logs and the stack's events, for a failed run`,
    ]
    const found = [DEPLOY, DESTROY].flatMap((file) =>
      steps(file)
        .filter(([, s]) => /\|\|\s*(true\b|:|exit 0\b)/.test(s.run ?? ''))
        .map(([id, s]) => `${file}#${id}: ${s.name}`),
    )
    expect(found).toEqual(allowed)
    expect(step(DEPLOY, 'deploy', "The API's logs and the stack's events, for a failed run").if).toBe('failure()')
    // The readiness poll ignores one curl's failure but fails the step after ten minutes without a 200.
    expect(step(DEPLOY, 'deploy', 'Wait until the demo answers over HTTPS').run).toMatch(/\n\s*exit 1\s*$/)
  })

  it('AC-AWS-07: the evidence job runs after any outcome once the gate passed', () => {
    const evidence = job(DEPLOY, 'evidence')
    expect(evidence.needs).toEqual(['gate', 'deploy', 'destroy'])
    expect(evidence.if).toBe("always() && needs.gate.result == 'success'")
  })
})
