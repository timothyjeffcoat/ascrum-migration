import { describe, expect, it } from 'vitest'
import {
  awsErrorLine,
  awsJson,
  commandData,
  ERROR_TEXT_LIMIT,
  printable,
  redact,
  stackStatus,
  type Aws,
} from './aws.ts'

const failing =
  (stderr: string): Aws =>
  async () => ({ code: 254, stdout: '', stderr })

describe('AC-AWS-04: stackStatus() reads absence only from CloudFormation’s own answer (S22)', () => {
  it('AC-AWS-04: "ValidationError … Stack with id … does not exist" means the stack is absent', async () => {
    const aws = failing(
      '\nAn error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id AscrumDemo does not exist\n',
    )
    expect(await stackStatus(aws, 'AscrumDemo', 'eu-west-1')).toBeNull()
  })

  it('AC-AWS-04 (S22): any other failure throws, even one that says "does not exist"', async () => {
    for (const stderr of [
      'An error occurred (AccessDenied) when calling the DescribeStacks operation: User: arn:aws:sts::123456789012:assumed-role/x is not authorized',
      'An error occurred (ExpiredToken) when calling the DescribeStacks operation: The security token included in the request is expired',
      'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded',
      'Could not connect to the endpoint URL: "https://cloudformation.eu-west-1.amazonaws.com/"',
      'An error occurred (AccessDenied) when calling the AssumeRole operation: the role does not exist',
      '',
    ]) {
      await expect(stackStatus(failing(stderr), 'AscrumDemo', 'eu-west-1'), stderr).rejects.toThrow(
        'describe-stacks AscrumDemo failed',
      )
    }
  })

  it('AC-AWS-04: DELETE_COMPLETE reads as absent; any other status is returned', async () => {
    const answering =
      (status: string): Aws =>
      async () => ({ code: 0, stdout: JSON.stringify({ Stacks: [{ StackStatus: status }] }), stderr: '' })
    expect(await stackStatus(answering('DELETE_COMPLETE'), 'AscrumDemo', 'eu-west-1')).toBeNull()
    expect(await stackStatus(answering('ROLLBACK_COMPLETE'), 'AscrumDemo', 'eu-west-1')).toBe('ROLLBACK_COMPLETE')
  })

  it('spec §11: redact() hides 12-digit account ids', () => {
    expect(redact('arn:aws:iam::123456789012:role/x')).toBe('arn:aws:iam::***:role/x')
  })
})

describe('sec-05: awsErrorLine() turns stderr into one short printable line', () => {
  it('sec-05: only the first non-empty line, account ids scrubbed, control characters gone', () => {
    const line = awsErrorLine({
      code: 254,
      stderr: '\n  An error occurred (AccessDenied): arn:aws:sts::123456789012:x\r::add-mask::y\nsecond line\n',
    })
    expect(line).toBe('An error occurred (AccessDenied): arn:aws:sts::***:x ::add-mask::y')
  })

  it(`sec-05 / R06: at most ${ERROR_TEXT_LIMIT} characters are echoed`, () => {
    expect(ERROR_TEXT_LIMIT).toBe(160)
    expect(awsErrorLine({ code: 1, stderr: 'x'.repeat(500) })).toBe('x'.repeat(160))
  })

  it('sec-05: no stderr at all gives the exit code', () => {
    expect(awsErrorLine({ code: 255, stderr: '\n\n' })).toBe('exit 255')
  })

  it('DEV-p5-infra-38: printable() turns line separators, bidi controls and zero-width characters into spaces', () => {
    const invisible = [
      0x2028, 0x2029, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b,
      0x200c, 0x200d, 0xfeff,
    ]
    const text = invisible.map((code) => `a${String.fromCodePoint(code)}`).join('')
    expect(printable(text)).toBe('a '.repeat(invisible.length))
  })

  // DEV-p5-infra-43 Q07: awsJson's message carries its arguments and stderr; both are cleaned.
  it('Q07: awsJson() throws one cleaned line: no account id, no control character, no second line', async () => {
    const aws: Aws = async () => ({
      code: 254,
      stdout: '',
      stderr: 'An error occurred (AccessDenied): arn:aws:sts::123456789012:x\r::add-mask::y\nsecond line',
    })
    const error = await awsJson(aws, ['s3', 'rm', 's3://bucket-123456789012\u001b[2J']).then(
      () => new Error('resolved'),
      (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
    )
    expect(error.message).toBe(
      'aws s3 rm s3://bucket-*** [2J failed (254): An error occurred (AccessDenied): arn:aws:sts::***:x ::add-mask::y',
    )
  })

  it('sec-07: commandData() escapes % as %25 after printable()', () => {
    expect(commandData('a%0Ab\r%25c')).toBe('a%250Ab %2525c')
  })

  it('sec-04 / DEV-p5-infra-40: printable() turns DEL (U+007F) into a space', () => {
    expect(printable('OK\u007fDEL')).toBe('OK DEL')
  })
})
