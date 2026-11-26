// The AWS CLI as a function, so the destroy and leftover scripts can be tested with a fake. The real one
// runs `aws … --output json` with whatever credentials the workflow's OIDC step put in the environment;
// on a developer's machine nobody runs these scripts (spec §11: agents never use AWS credentials).
import { execFile } from 'node:child_process'

export type AwsResult = { code: number; stdout: string; stderr: string }
export type Aws = (args: string[]) => Promise<AwsResult>

export const awsCli: Aws = (args) =>
  new Promise((resolve) => {
    execFile('aws', [...args, '--output', 'json'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })

/** Runs a call that must succeed and returns its JSON (or null for an empty answer). */
export async function awsJson(aws: Aws, args: string[]): Promise<unknown> {
  const result = await aws(args)
  if (result.code !== 0) {
    throw new Error(`aws ${printable(args.join(' '))} failed (${result.code}): ${awsErrorLine(result)}`)
  }
  return result.stdout.trim() === '' ? null : JSON.parse(result.stdout)
}

export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * CloudFormation's one answer that means "no such stack". Anything else that fails (AccessDenied, an
 * expired token, throttling, a network error) is not proof of absence and must stop the caller:
 * otherwise destroy and the leftover check would both pass while the stacks still stand (S22).
 */
export const STACK_DOES_NOT_EXIST = /\(ValidationError\)[^\n]*Stack with id \S+ does not exist/

/** CloudFormation status of a stack, or null when it does not exist (or was deleted). */
export async function stackStatus(aws: Aws, stack: string, region: string): Promise<string | null> {
  const result = await aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region])
  if (result.code !== 0) {
    if (STACK_DOES_NOT_EXIST.test(result.stderr)) return null
    throw new Error(`describe-stacks ${stack} failed: ${awsErrorLine(result)}`)
  }
  const body = JSON.parse(result.stdout) as { Stacks?: { StackStatus?: string }[] }
  const status = body.Stacks?.[0]?.StackStatus ?? null
  return status === 'DELETE_COMPLETE' ? null : status
}

/** Account ids stay out of public logs and artifacts (spec §11): any 12-digit number becomes ***. */
export function redact(text: string): string {
  return text.replace(/\b\d{12}\b/g, '***')
}

// Characters that move text without being visible: line and paragraph separators, bidi controls and
// zero-width characters (DEV-p5-infra-38). Together with C0, DEL and C1 below, none can forge a line or
// hide text in a log or an evidence file.
const INVISIBLE = new Set([
  0x2028, 0x2029, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b,
  0x200c, 0x200d, 0xfeff,
])

/**
 * AWS-supplied text made safe to print: every control character becomes a space, so it cannot start a
 * new line, move the cursor or hide text (no forged "OK: …" or "Remaining: 0" line and no `::` workflow
 * command in the log or the evidence file; sec-04). C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F,
 * which holds an 8-bit CSI) and the INVISIBLE set are covered. Then the 12-digit scrub.
 */
export function printable(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || INVISIBLE.has(code) ? ' ' : char
  }
  return redact(out)
}

/** At most this many characters of AWS error text are echoed. */
export const ERROR_TEXT_LIMIT = 160

/**
 * A failed CLI call's stderr as one short printable line, for an error message (sec-05): its first
 * non-empty line, cleaned by printable() and cut to ERROR_TEXT_LIMIT, or the exit code when there is none.
 * The rest of stderr never reaches a log or an artifact.
 */
export function awsErrorLine(result: { code: number; stderr: string }): string {
  const first = result.stderr.split('\n').find((line) => line.trim() !== '') ?? ''
  return printable(first).trim().slice(0, ERROR_TEXT_LIMIT) || `exit ${result.code}`
}

/**
 * The main block of every script a workflow runs through this module (destroy, leftovers, image-scan):
 * any error is printed as one printable line, without a stack, and the process exits 1, so the step still
 * fails closed. Node's default would print the message and stack raw into the tee'd evidence (sec-05).
 */
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error(`::error::${printable(error instanceof Error ? error.message : String(error))}`)
    process.exit(1)
  }
}
