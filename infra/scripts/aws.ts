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
  if (result.code !== 0) throw new Error(`aws ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
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
    throw new Error(`describe-stacks ${stack} failed: ${result.stderr.trim()}`)
  }
  const body = JSON.parse(result.stdout) as { Stacks?: { StackStatus?: string }[] }
  const status = body.Stacks?.[0]?.StackStatus ?? null
  return status === 'DELETE_COMPLETE' ? null : status
}

/** Account ids stay out of public logs and artifacts (spec §11): any 12-digit number becomes ***. */
export function redact(text: string): string {
  return text.replace(/\b\d{12}\b/g, '***')
}
