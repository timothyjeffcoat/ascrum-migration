import { describe, expect, it } from 'vitest'
import { redact, stackStatus, type Aws } from './aws.ts'

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
