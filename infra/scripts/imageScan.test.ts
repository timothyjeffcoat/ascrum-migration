// spec §6 image-scan, after live run 1 (ScanNotFoundException right after the push): the gate waits for a
// scan, starts one if none appears, and passes only a completed scan with no HIGH or CRITICAL finding.
import { describe, expect, it } from 'vitest'
import type { Aws, AwsResult } from './aws.ts'
import { blockingCount, scanImage, verdict } from './imageScan.ts'

const NOT_FOUND: AwsResult = {
  code: 254,
  stdout: '',
  stderr:
    "An error occurred (ScanNotFoundException) when calling the DescribeImageScanFindings operation: Image scan does not exist for the image with '{imageDigest:'null', imageTag:'abc'}' in the repository with name 'ascrum-demo-api'",
}
const findings = (status: string, counts: Record<string, number> = {}): AwsResult => ({
  code: 0,
  stderr: '',
  stdout: JSON.stringify({
    registryId: '123456789012',
    imageScanStatus: { status },
    imageScanFindings: {
      imageScanCompletedAt: status === 'COMPLETE' ? '2026-11-24T12:00:00Z' : undefined,
      findingSeverityCounts: counts,
      findings: Object.keys(counts).map((severity) => ({ name: `CVE-${severity}`, severity, uri: 'https://x' })),
    },
  }),
})

const DIGEST = 'sha256:' + 'a'.repeat(64)
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
/** describe-images for the tag: what ECR stored under it. */
const images = (...details: { imageDigest?: string; imageManifestMediaType?: string }[]): AwsResult => ({
  code: 0,
  stderr: '',
  stdout: JSON.stringify({
    imageDetails: details.map((d) => ({ registryId: '123456789012', imageTags: ['abc'], ...d })),
  }),
})
const SINGLE = images({ imageDigest: DIGEST, imageManifestMediaType: OCI_MANIFEST })

/**
 * describe-images answers `image` (by default one OCI image manifest); describe-image-scan-findings answers
 * in order (the last repeats); start-image-scan as given. `argv` keeps each call's full arguments.
 */
function scripted(
  describes: AwsResult[],
  start: AwsResult = { code: 0, stdout: '{}', stderr: '' },
  image: AwsResult = SINGLE,
) {
  const calls: string[] = []
  const argv: string[] = []
  let next = 0
  const aws: Aws = async (args) => {
    calls.push(args.slice(0, 2).join(' '))
    argv.push(args.join(' '))
    if (args[1] === 'describe-images') return image
    if (args[1] === 'start-image-scan') return start
    if (args[1] === 'describe-image-scan-findings') {
      const answer = describes[Math.min(next, describes.length - 1)] as AwsResult
      next++
      return answer
    }
    return { code: 99, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { aws, calls, argv }
}

const run = (aws: Aws) =>
  scanImage({
    aws,
    repository: 'ascrum-demo-api',
    imageTag: 'abc',
    region: 'eu-west-1',
    sleep: async () => {},
    log: () => {},
    pollMs: 10,
    appearMs: 30,
    completeMs: 50,
  })

describe('spec §6 image-scan: the scan gate', () => {
  it('image-scan: a scan on push that completes clean passes, and no scan is started', async () => {
    const { aws, calls } = scripted([findings('IN_PROGRESS'), findings('COMPLETE', { LOW: 2 })])
    const summary = await run(aws)
    expect(summary).toMatchObject({ status: 'COMPLETE', startedByThisRun: false, counts: { LOW: 2 } })
    expect(verdict(summary)).toBeNull()
    expect(calls).not.toContain('ecr start-image-scan')
  })

  it('image-scan (live run 1): ScanNotFoundException right after the push is waited out, not a failure', async () => {
    const { aws, calls } = scripted([NOT_FOUND, NOT_FOUND, findings('COMPLETE')])
    const summary = await run(aws)
    expect(summary).toMatchObject({ status: 'COMPLETE', startedByThisRun: false })
    expect(verdict(summary)).toBeNull()
    expect(calls).not.toContain('ecr start-image-scan')
  })

  it('image-scan (live run 1): no scan ever appears: the gate starts one and waits for it to complete', async () => {
    const { aws, calls } = scripted([
      NOT_FOUND,
      NOT_FOUND,
      NOT_FOUND,
      NOT_FOUND,
      findings('IN_PROGRESS'),
      findings('COMPLETE'),
    ])
    const summary = await run(aws)
    expect(summary).toMatchObject({ status: 'COMPLETE', startedByThisRun: true })
    expect(verdict(summary)).toBeNull()
    expect(calls.filter((c) => c === 'ecr start-image-scan')).toHaveLength(1)
    expect(calls.indexOf('ecr start-image-scan')).toBe(5) // after describe-images and the four describes of the wait
  })

  it('image-scan: never passes without a completed scan: still missing after the start, or never completing', async () => {
    const missing = await run(scripted([NOT_FOUND]).aws)
    expect(missing.status).toBe('NOT_FOUND')
    expect(verdict(missing)).toMatch(/did not complete \(NOT_FOUND\)/)
    const stuck = await run(scripted([findings('IN_PROGRESS')]).aws)
    expect(verdict(stuck)).toMatch(/did not complete \(IN_PROGRESS\)/)
    for (const status of ['FAILED', 'UNSUPPORTED_IMAGE', 'FINDINGS_UNAVAILABLE', 'LIMIT_EXCEEDED', 'ACTIVE']) {
      expect(verdict(await run(scripted([findings(status)]).aws)), status).toMatch(/did not complete/)
    }
  })

  it('image-scan: any HIGH or CRITICAL finding fails a completed scan', async () => {
    for (const counts of [{ HIGH: 1 }, { CRITICAL: 1 }, { HIGH: 2, CRITICAL: 3, LOW: 9 }] as Record<string, number>[]) {
      const summary = await run(scripted([findings('COMPLETE', counts)]).aws)
      expect(blockingCount(summary)).toBe((counts.HIGH ?? 0) + (counts.CRITICAL ?? 0))
      expect(verdict(summary), JSON.stringify(counts)).toMatch(/HIGH or CRITICAL findings/)
    }
    expect(verdict(await run(scripted([findings('COMPLETE', { MEDIUM: 5, LOW: 1, INFORMATIONAL: 3 })]).aws))).toBeNull()
  })

  it('image-scan: any other error stops the gate: an AccessDenied on describe, a refused start', async () => {
    const denied: AwsResult = {
      code: 254,
      stdout: '',
      stderr: 'An error occurred (AccessDeniedException) for 123456789012',
    }
    await expect(run(scripted([denied]).aws)).rejects.toThrow(/describe-image-scan-findings failed: .*\*\*\*/)
    const limit: AwsResult = { code: 254, stdout: '', stderr: 'An error occurred (LimitExceededException)' }
    await expect(run(scripted([NOT_FOUND], limit).aws)).rejects.toThrow(/start-image-scan failed: .*LimitExceeded/)
  })

  it('image-scan: the evidence summary carries no registry (account) id', async () => {
    const summary = await run(scripted([findings('COMPLETE', { LOW: 1 })]).aws)
    expect(JSON.stringify(summary)).not.toContain('123456789012')
  })

  it('image-scan (live run 2): an OCI image index under the tag fails the gate before any scan, with the media type', async () => {
    // Run 2 pushed the image plus a BuildKit attestation manifest as an index; StartImageScan refused it.
    const index = images({ imageDigest: DIGEST, imageManifestMediaType: OCI_INDEX })
    const { aws, calls } = scripted([findings('COMPLETE')], undefined, index)
    const summary = await run(aws)
    expect(summary).toMatchObject({ status: 'UNSCANNABLE_MEDIA_TYPE', mediaType: OCI_INDEX, imageDigest: DIGEST })
    expect(verdict(summary)).toMatch(/did not complete \(UNSCANNABLE_MEDIA_TYPE\)/)
    expect(calls).toEqual(['ecr describe-images'])
  })

  it('image-scan (live run 2): a manifest list, an unknown or missing media type, no image or two fail the gate', async () => {
    for (const image of [
      images({
        imageDigest: DIGEST,
        imageManifestMediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
      }),
      images({ imageDigest: DIGEST, imageManifestMediaType: 'application/vnd.oci.artifact.manifest.v1+json' }),
      images({ imageDigest: DIGEST }),
      images({ imageManifestMediaType: OCI_MANIFEST }),
      images(),
      images(
        { imageDigest: DIGEST, imageManifestMediaType: OCI_MANIFEST },
        { imageDigest: DIGEST, imageManifestMediaType: OCI_MANIFEST },
      ),
    ]) {
      const summary = await run(scripted([findings('COMPLETE')], undefined, image).aws)
      expect(verdict(summary), image.stdout).toMatch(/UNSCANNABLE_MEDIA_TYPE/)
    }
    const missing: AwsResult = { code: 254, stdout: '', stderr: 'An error occurred (ImageNotFoundException)' }
    await expect(run(scripted([findings('COMPLETE')], undefined, missing).aws)).rejects.toThrow(
      /describe-images failed/,
    )
  })

  it('image-scan (live run 2): a single manifest (OCI or Docker v2) is scanned by its digest, never by the tag', async () => {
    for (const mediaType of [OCI_MANIFEST, 'application/vnd.docker.distribution.manifest.v2+json']) {
      const image = images({ imageDigest: DIGEST, imageManifestMediaType: mediaType })
      const { aws, argv } = scripted(
        [NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND, findings('COMPLETE')],
        undefined,
        image,
      )
      const summary = await run(aws)
      expect(summary).toMatchObject({ status: 'COMPLETE', imageDigest: DIGEST, mediaType, startedByThisRun: true })
      expect(verdict(summary)).toBeNull()
      const scans = argv.filter((a) => !a.startsWith('ecr describe-images'))
      expect(scans.length).toBeGreaterThan(0)
      for (const call of scans) expect(call).toContain(`--image-id imageDigest=${DIGEST} `)
    }
  })
})
