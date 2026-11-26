// A stand-in `aws` executable for the entry-point tests (entrypoints.test.ts): the scripts run as the
// workflows run them, as processes, with this on PATH instead of the AWS CLI. Each call is answered by the
// first rule whose `match` is a prefix of the call's arguments (FAKE_AWS_RULES, JSON), and appended to
// FAKE_AWS_LOG. An unexpected call fails loudly. No network, no credentials.
import { appendFileSync } from 'node:fs'

/** `stdoutRaw` is written as is (an answer that is not JSON); `stdout` is written as JSON. */
type Rule = { match: string; code?: number; stdout?: unknown; stdoutRaw?: string; stderr?: string }

const args = process.argv.slice(2).join(' ')
if (process.env.FAKE_AWS_LOG) appendFileSync(process.env.FAKE_AWS_LOG, `${args}\n`)
const rules = JSON.parse(process.env.FAKE_AWS_RULES ?? '[]') as Rule[]
const rule = rules.find((candidate) => args.startsWith(candidate.match))
if (!rule) {
  process.stderr.write(`fake aws: unexpected call: ${args}\n`)
  process.exit(99)
}
if (rule.stdoutRaw !== undefined) process.stdout.write(rule.stdoutRaw)
else if (rule.stdout !== undefined) process.stdout.write(JSON.stringify(rule.stdout))
if (rule.stderr) process.stderr.write(rule.stderr)
process.exit(rule.code ?? 0)
