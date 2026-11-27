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

describe('Q-p5-infra-14 (a): printable() keeps only printable ASCII, U+0020-U+007E', () => {
  const ch = (code: number) => String.fromCodePoint(code)

  it('Q-p5-infra-14: each previously missed character, and a non-ASCII letter, becomes one space', () => {
    // U+061C Arabic letter mark, U+180E Mongolian vowel separator, U+2060 word joiner, U+00AD soft hyphen,
    // U+FE0F variation selector-16, U+E0041 tag letter A (a surrogate pair: one code point), U+00E9 e-acute.
    for (const code of [0x061c, 0x180e, 0x2060, 0x00ad, 0xfe0f, 0xe0041, 0x00e9]) {
      expect(printable(`a${ch(code)}b`), `U+${code.toString(16).toUpperCase()}`).toBe('a b')
    }
    expect(printable(`caf${ch(0xe9)} ${ch(0xe0041)}${ch(0xe0042)}!`)).toBe('caf    !')
  })

  it('Q-p5-infra-14: every printable ASCII character is kept as it is', () => {
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join('')
    expect(printable(ascii)).toBe(ascii)
  })

  it('Q-p5-infra-14: an account id is scrubbed, also next to a removed character', () => {
    expect(printable('id 123456789012 x')).toBe('id *** x')
    expect(printable(`arn:aws:sts::123456789012${ch(0x200b)}:x`)).toBe('arn:aws:sts::*** :x')
  })
})

describe('DEV-p5-infra-44 (sec-09): an account id split by a removed code point is scrubbed as one', () => {
  const ch = (code: number) => String.fromCodePoint(code)

  it('DEV-p5-infra-44: U+00AD or U+200B inside a 12-digit run is deleted, and the run is scrubbed', () => {
    for (const code of [0x00ad, 0x200b]) {
      const hex = `U+${code.toString(16).toUpperCase()}`
      expect(printable(`id 123456${ch(code)}789012 x`), hex).toBe('id *** x')
      expect(printable(`arn:aws:sts::1${ch(code)}2345678901${ch(code)}2:assumed-role`), hex).toBe(
        'arn:aws:sts::***:assumed-role',
      )
    }
    // Several removed code points in a row, a surrogate pair among them, are deleted together.
    expect(printable(`id 1234${ch(0x00ad)}${ch(0xe0041)}${ch(0x200b)}56789012 x`)).toBe('id *** x')
  })

  it('DEV-p5-infra-44: a removed code point next to only one digit still becomes a space', () => {
    expect(printable(`a${ch(0x00ad)}1 2${ch(0x200b)}b`)).toBe('a 1 2 b')
  })

  it('DEV-p5-infra-44: an id that is already whole stays scrubbed when the deletion glues a digit to it', () => {
    // Without the first redact() on the raw text, this would print 13 digits and nothing would be scrubbed.
    expect(printable(`id 123456789012${ch(0x00ad)}3 x`)).toBe('id *** 3 x')
  })

  it('DEV-p5-infra-44: a plain-space split is not an account id and stays as it is today', () => {
    expect(printable('id 123456 789012 x')).toBe('id 123456 789012 x')
  })
})

describe('DEV-p5-infra-45 (sec-10): a run of 12 or more digits is scrubbed, also after the deletion', () => {
  const ch = (code: number) => String.fromCodePoint(code)
  const twelveOrMore = /\d{12,}/

  it('DEV-p5-infra-45: a split id with a glued extra digit never prints 12 or more digits in a row', () => {
    const out = printable(`id 1${ch(0x00ad)}123456${ch(0x00ad)}789012 x`)
    expect(out).not.toMatch(twelveOrMore)
    expect(out).toBe('id *** x')
    // A whole id is scrubbed by the first pass, so the stray digit stays apart (the mirror of `*** 3`).
    expect(printable(`arn:aws:sts::1${ch(0x200b)}123456789012:role`)).toBe('arn:aws:sts::1 ***:role')
  })

  it('DEV-p5-infra-45: plain 12-digit and 13-digit ids are scrubbed, by printable() and by redact()', () => {
    for (const text of ['id 123456789012 x', 'id 1234567890123 x', 'id 12345678901234567890 x']) {
      expect(printable(text), text).toBe('id *** x')
      expect(redact(text), text).toBe('id *** x')
    }
    expect(redact('arn:aws:iam::1234567890123:role/x')).toBe('arn:aws:iam::***:role/x')
  })

  it('DEV-p5-infra-45: shorter numbers, ISO timestamps and digits inside hex ids are unchanged', () => {
    for (const text of [
      'id 12345678901 x',
      'revision 42, exit 254, epoch 1764000000',
      '2026-11-27T10:15:30.123Z',
      'task 0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'sha256:abc1234567890123456def',
    ]) {
      expect(printable(text), text).toBe(text)
    }
  })
})
