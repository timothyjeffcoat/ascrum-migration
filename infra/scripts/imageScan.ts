// spec §6 image-scan (Q-p5-7): the API image may be deployed only after a completed ECR basic scan with no
// HIGH or CRITICAL finding. Used by the deploy job of deploy-demo.yml, between the push and the demo stack.
//
//   AWS_REGION=… node infra/scripts/imageScan.ts <repository> <image tag> <evidence json>
//
// The first live run (worklog, 2026-11-24, live run 1) found no scan at all right after the push
// (ScanNotFoundException). ECR's basic scanning is configured per registry, and a registry's default is
// manual scanning for every repository; the repository's own scanOnPush setting comes from an API ECR
// is deprecating. So: wait a bounded time for a scan on push to appear, start one if none does, and wait
// a bounded time for it to complete. Only COMPLETE passes; every other outcome, a timeout or an error
// fails the step. The findings summary is written to the evidence file whatever the result.
//
// The second live run (worklog, 2026-11-25, live run 2) pushed an OCI image index (the image plus a
// BuildKit attestation manifest), and StartImageScan refused it: "An artifact with media type
// 'application/vnd.oci.image.index.v1+json' cannot be scanned." The workflow now builds a single image
// manifest (--provenance=false --sbom=false), and this script checks that first: the tag (immutable) must
// name a single image manifest, which is then scanned by its digest. Anything else fails the step before
// any scan is waited for.
//
// The third live run (spec/worklogs/p5-image-cves.md, run 45664652733) failed the gate on six findings, and
// the evidence could not say which packages they matched: only name, severity and uri were kept. Each
// finding now also keeps the package ECR matched, from the finding's attributes (`package_name`,
// `package_version`, as the DescribeImageScanFindings reference shows for basic scanning). Basic scanning
// documents no fixed-in attribute (fixedInVersion exists only in enhancedFindings, Inspector's), so none
// is recorded. The pass/fail verdict still reads only the severity counts.
import { writeFileSync } from 'node:fs'
import { awsCli, awsErrorLine, realSleep, runMain, type Aws, type Sleep } from './aws.ts'

export type ScanSummary = {
  status: string
  /** The scanned manifest, which the immutable tag names and the demo's task definition runs. */
  imageDigest: string | null
  mediaType: string | null
  completedAt: string | null
  /** Whether this script had to start the scan (no scan on push appeared). */
  startedByThisRun: boolean
  counts: Record<string, number>
  findings: Finding[]
}

/** One finding as the evidence keeps it: the package fields are null when ECR's attributes do not name them. */
export type Finding = {
  name?: string
  severity?: string
  uri?: string
  package_name: string | null
  package_version: string | null
}

type RawFinding = {
  name?: string
  severity?: string
  uri?: string
  attributes?: { key?: string; value?: string }[]
}

const attribute = (finding: RawFinding, key: string): string | null =>
  finding.attributes?.find((a) => a.key === key)?.value ?? null

/** What the evidence keeps of a finding: never its description or CVSS attributes, only what names it. */
const toFinding = (finding: RawFinding): Finding => ({
  name: finding.name,
  severity: finding.severity,
  uri: finding.uri,
  package_name: attribute(finding, 'package_name'),
  package_version: attribute(finding, 'package_version'),
})

export type ScanOptions = {
  aws: Aws
  repository: string
  imageTag: string
  region: string
  sleep?: Sleep
  log?: (line: string) => void
  /** How long a scan on push may take to appear before this script starts one. */
  appearMs?: number
  /** How long a started scan may take to complete. */
  completeMs?: number
  pollMs?: number
}

const SCAN_NOT_FOUND = /\(ScanNotFoundException\)/
/** Single image manifests, which ECR basic scanning accepts. An image index or a manifest list is not one. */
export const SCANNABLE_MEDIA_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]
const BLOCKING = ['HIGH', 'CRITICAL']

type ImageDetail = { imageDigest?: string; imageManifestMediaType?: string }

type Findings = {
  imageScanStatus?: { status?: string; description?: string }
  imageScanFindings?: {
    imageScanCompletedAt?: string
    findingSeverityCounts?: Record<string, number>
    findings?: RawFinding[]
  }
}

/** The number of HIGH and CRITICAL findings in a summary. */
export const blockingCount = (summary: ScanSummary): number =>
  BLOCKING.reduce((sum, severity) => sum + (summary.counts[severity] ?? 0), 0)

export async function scanImage(options: ScanOptions): Promise<ScanSummary> {
  const { aws, repository, imageTag, region } = options
  const sleep = options.sleep ?? realSleep
  const log = options.log ?? ((line: string) => console.log(line))
  const pollMs = options.pollMs ?? 10_000
  const empty = { completedAt: null, startedByThisRun: false, counts: {}, findings: [] }

  // What the tag names. Any error (the image missing, access denied) stops the step.
  const described = await aws([
    'ecr',
    'describe-images',
    '--repository-name',
    repository,
    '--image-ids',
    `imageTag=${imageTag}`,
    '--region',
    region,
  ])
  if (described.code !== 0) throw new Error(`describe-images failed: ${awsErrorLine(described)}`)
  const details = (JSON.parse(described.stdout) as { imageDetails?: ImageDetail[] }).imageDetails ?? []
  const detail = details.length === 1 ? details[0] : undefined
  const mediaType = detail?.imageManifestMediaType ?? null
  const imageDigest = detail?.imageDigest ?? null
  if (!imageDigest || !mediaType || !SCANNABLE_MEDIA_TYPES.includes(mediaType)) {
    log(`${imageTag} is not a single image manifest (${mediaType ?? 'no media type'}); ECR cannot scan it.`)
    return { status: 'UNSCANNABLE_MEDIA_TYPE', imageDigest, mediaType, ...empty }
  }
  const image = ['--repository-name', repository, '--image-id', `imageDigest=${imageDigest}`, '--region', region]

  /** The scan's findings, or null while ECR has no scan for the image. Any other error stops the step. */
  const describe = async (): Promise<Findings | null> => {
    const result = await aws(['ecr', 'describe-image-scan-findings', ...image])
    if (result.code === 0) return JSON.parse(result.stdout) as Findings
    if (SCAN_NOT_FOUND.test(result.stderr)) return null
    throw new Error(`describe-image-scan-findings failed: ${awsErrorLine(result)}`)
  }
  const poll = async (ms: number, done: (body: Findings | null) => boolean) => {
    let body = await describe()
    for (let waited = 0; !done(body) && waited < ms; waited += pollMs) {
      await sleep(pollMs)
      body = await describe()
    }
    return body
  }

  let startedByThisRun = false
  let body = await poll(options.appearMs ?? 120_000, (b) => b !== null)
  if (body === null) {
    log('No scan appeared after the push (the registry scans this repository manually); starting one.')
    const started = await aws(['ecr', 'start-image-scan', ...image])
    if (started.code !== 0) throw new Error(`start-image-scan failed: ${awsErrorLine(started)}`)
    startedByThisRun = true
  }
  const pending = (b: Findings | null) =>
    b === null || ['IN_PROGRESS', 'PENDING'].includes(b.imageScanStatus?.status ?? '')
  body = await poll(options.completeMs ?? 900_000, (b) => !pending(b))
  const status = body?.imageScanStatus?.status ?? 'NOT_FOUND'
  const summary: ScanSummary = {
    status,
    imageDigest,
    mediaType,
    completedAt: body?.imageScanFindings?.imageScanCompletedAt ?? null,
    startedByThisRun,
    counts: body?.imageScanFindings?.findingSeverityCounts ?? {},
    findings: (body?.imageScanFindings?.findings ?? []).map(toFinding),
  }
  log(`scan ${status}${startedByThisRun ? ' (started by this run)' : ' (on push)'}: ${JSON.stringify(summary.counts)}`)
  return summary
}

/** Why the image may not be deployed, or null when it may. */
export function verdict(summary: ScanSummary): string | null {
  if (summary.status !== 'COMPLETE') {
    return `The image scan did not complete (${summary.status}); the image-scan gate passes only a completed scan.`
  }
  const blocking = blockingCount(summary)
  if (blocking !== 0) return `The API image has ${blocking} HIGH or CRITICAL findings (image-scan gate, spec §6).`
  return null
}

if (import.meta.main) {
  await runMain(async () => {
    const [repository, imageTag, evidence] = process.argv.slice(2)
    const region = process.env.AWS_REGION
    if (!repository || !imageTag || !evidence || !region) {
      console.error('usage: AWS_REGION=… node imageScan.ts <repository> <image tag> <evidence json>')
      process.exit(2)
    }
    // Two minutes for a scan on push to appear, fifteen for a scan to complete, polled every 10 s. Only the
    // entry-point tests shorten the poll (IMAGE_SCAN_POLL_MS); the workflow never sets it (workflows.test.ts).
    const pollMs = Number(process.env.IMAGE_SCAN_POLL_MS ?? 10_000)
    const summary = await scanImage({
      aws: awsCli,
      repository,
      imageTag,
      region,
      pollMs,
      appearMs: 12 * pollMs,
      completeMs: 90 * pollMs,
    })
    writeFileSync(evidence, `${JSON.stringify(summary, null, 2)}\n`)
    const reason = verdict(summary)
    if (reason) {
      console.error(`::error::${reason}`)
      process.exit(1)
    }
    console.log('image-scan: completed, no HIGH or CRITICAL finding.')
  })
}
