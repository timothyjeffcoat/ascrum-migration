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

/**
 * Account ids stay out of public logs and artifacts (spec §11): any number of 12 or more digits becomes ***.
 * "Or more" (DEV-p5-infra-45, sec-10): printable() deletes removed code points between digits, so
 * `1<U+00AD>123456<U+00AD>789012` joins into 13 digits, which an exact `\d{12}` let through. A longer run is
 * scrubbed whole, never cut down to a visible remainder. Nothing these scripts print needs a 12+ digit
 * number: timestamps are ISO dates or epoch seconds (10 digits), ARNs carry the account id (scrubbed
 * anyway), and the other ids are hex or UUIDs, which `\b` keeps out unless they are all digits.
 */
export function redact(text: string): string {
  return text.replace(/\b\d{12,}\b/g, '***')
}

/**
 * AWS-supplied text made safe to print (sec-04; Q-p5-infra-14, owner answer (a)): only printable ASCII,
 * U+0020-U+007E, is kept. Every other code point becomes one space, so nothing can start a new line, move
 * the cursor, reorder or hide text: no forged "OK: ..." or "Remaining: 0" line and no `::` workflow command
 * in a log or an evidence file. That covers C0, DEL, C1, line separators, bidi controls, zero-width and
 * format characters, variation selectors and tag characters; `for ... of` walks code points, so a surrogate
 * pair becomes one space.
 *
 * The account-id scrub (DEV-p5-infra-44, sec-09): removed code points that sit between two digits are
 * deleted rather than spaced, so `123456<U+00AD>789012` joins up and is scrubbed as one id; on screen it
 * reads as one anyway. redact() also runs on the raw text first, so an id that is already whole keeps its
 * shape when the deletion glues another digit to it (`123456789012<U+00AD>3` prints `*** 3`). The second
 * redact() scrubs any run of 12 or more digits the deletion made (DEV-p5-infra-45), so no split, glued or
 * long id prints 12 digits in a row. Over-scrubbing is the safe direction. An ASCII space still separates
 * numbers, as it always has.
 */
export function printable(text: string): string {
  const chars = [...redact(text)]
  let out = ''
  for (const [i, char] of chars.entries()) {
    if (isPrintableAscii(char)) {
      out += char
      continue
    }
    let next = i + 1
    while (next < chars.length && !isPrintableAscii(chars[next] ?? ' ')) next++
    out += isDigit(out.at(-1)) && isDigit(chars[next]) ? '' : ' '
  }
  return redact(out)
}

function isPrintableAscii(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x20 && code <= 0x7e
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
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
    console.error(`::error::${commandData(error instanceof Error ? error.message : String(error))}`)
    process.exit(1)
  }
}

/**
 * Text for the data part of a GitHub workflow command (`::error::<data>`): printable(), then `%` escaped as
 * `%25`, as @actions/toolkit's escapeData does, so a `%0A` in AWS text cannot be read as an encoded newline
 * by the runner (sec-07). \r and \n need no escape here: printable() has made them spaces.
 */
export function commandData(text: string): string {
  return printable(text).replace(/%/g, '%25')
}
