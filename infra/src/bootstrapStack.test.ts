import { App } from 'aws-cdk-lib'
import { Match } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { buildStacks } from './app.ts'
import { actionsOf, ofType, resources, synth, TEST_REPOSITORY, type Statement } from './testApp.ts'

const { templates, stacks } = synth()
const bootstrap = templates.bootstrap

function deployRolePolicy(): Statement[] {
  const [[, policy] = ['', undefined]] = ofType(bootstrap, 'AWS::IAM::Policy')
  return (policy?.Properties?.PolicyDocument as { Statement: Statement[] }).Statement
}

function managedPolicy(name: string): Statement[] {
  const found = ofType(bootstrap, 'AWS::IAM::ManagedPolicy').find(([, r]) => r.Properties?.ManagedPolicyName === name)
  if (!found) throw new Error(`no managed policy ${name}`)
  return (found[1].Properties?.PolicyDocument as { Statement: Statement[] }).Statement
}

const json = (value: unknown) => JSON.stringify(value)

describe('bootstrap stack: OIDC and the deploy role', () => {
  it('AC-AWS-02: GitHub OIDC provider for sts.amazonaws.com, as a plain CloudFormation resource (no Lambda)', () => {
    bootstrap.resourceCountIs('AWS::IAM::OIDCProvider', 1)
    bootstrap.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    })
    bootstrap.resourceCountIs('AWS::Lambda::Function', 0)
  })

  it('AC-AWS-02: no long-lived credentials anywhere: no IAM user, access key or login profile in any stack', () => {
    for (const template of Object.values(templates)) {
      for (const type of [
        'AWS::IAM::User',
        'AWS::IAM::AccessKey',
        'AWS::IAM::UserToGroupAddition',
        'AWS::IAM::Group',
      ]) {
        template.resourceCountIs(type, 0)
      }
    }
  })

  it('AC-AWS-01 / AC-AWS-02: the deploy role trusts only the deploy and destroy workflows on migration, in the aws-demo environment', () => {
    const [[, role] = ['', undefined]] = ofType(bootstrap, 'AWS::IAM::Role')
    const trust = (role?.Properties?.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement
    expect(trust).toHaveLength(1)
    const [statement] = trust
    expect(statement?.Action).toBe('sts:AssumeRoleWithWebIdentity')
    expect(statement?.Effect).toBe('Allow')
    expect(Object.keys(statement?.Condition ?? {})).toEqual(['StringEquals']) // no StringLike, no wildcards
    expect(statement?.Condition?.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': [
        `repo:${TEST_REPOSITORY}:environment:aws-demo:job_workflow_ref:${TEST_REPOSITORY}/.github/workflows/deploy-demo.yml@refs/heads/migration`,
        `repo:${TEST_REPOSITORY}:environment:aws-demo:job_workflow_ref:${TEST_REPOSITORY}/.github/workflows/destroy-demo.yml@refs/heads/migration`,
      ],
    })
    expect(json(statement)).not.toContain('*')
    expect(role?.Properties?.MaxSessionDuration).toBe(7200)
  })

  it('AC-AWS-02: an existing OIDC provider can be reused (one per account) and nothing else changes', () => {
    const arn = 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com'
    const other = synth({ existingOidcProviderArn: arn }).templates.bootstrap
    other.resourceCountIs('AWS::IAM::OIDCProvider', 0)
    other.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    })
    // A plain string: toThrow() then checks for exactly this text, not a pattern.
    expect(() => synth({ existingOidcProviderArn: 'arn:aws:iam::111111111111:oidc-provider/example.com' })).toThrow(
      'existingOidcProviderArn must be the token.actions.githubusercontent.com provider',
    )
  })

  it('AC-AWS-01: refuses a repository that is not owner/repo (a wildcard would widen the trust)', () => {
    for (const bad of ['*', 'owner/*', 'owner', 'owner/repo:ref']) {
      expect(() => synth({ githubRepository: bad }), bad).toThrow(/owner\/repo/)
    }
    expect(() => buildStacks(new App(), {})).toThrow(/githubRepository/)
  })

  it('AC-AWS-02: the deploy role can use CDK and push/upload the demo only: no IAM writes, no wildcard actions', () => {
    const statements = deployRolePolicy()
    const actions = statements.flatMap(actionsOf)
    for (const action of actions) {
      expect(action, action).not.toMatch(/\*/)
      expect(action, action).not.toMatch(/^iam:/)
    }
    const assume = statements.find((s) => s.Sid === 'UseCdkBootstrapRoles')
    expect(actionsOf(assume as Statement)).toEqual(['sts:AssumeRole'])
    expect(json(assume?.Resource)).toMatch(/role\/cdk-ascrum-deploy-role-/)
    expect(json(assume?.Resource)).toMatch(/role\/cdk-ascrum-file-publishing-role-/)
    expect((assume?.Resource as unknown[]).length).toBe(2)
    const stacksStatement = statements.find((s) => s.Sid === 'DemoStacks')
    expect(actionsOf(stacksStatement as Statement)).toContain('cloudformation:DeleteStack')
    expect(json(stacksStatement?.Resource)).toContain(':stack/AscrumDemo*/*')
    // Writes name their resources; only read-only calls and the ECR login use "*".
    for (const statement of statements.filter((s) => s.Resource === '*')) {
      for (const action of actionsOf(statement)) {
        expect(action, action).toMatch(/:(Describe|Get|List)[A-Za-z]*$|^ecr:GetAuthorizationToken$/)
      }
    }
  })
})

describe('bootstrap stack: what CloudFormation may do for the demo stacks', () => {
  const execution = managedPolicy('ascrum-cdk-cfn-execution')
  const allow = execution.filter((s) => s.Effect === 'Allow')

  it('AC-AWS-02: no "*" or "service:*" action; writes are listed one by one', () => {
    for (const action of allow.flatMap(actionsOf)) {
      expect(action, action).not.toBe('*')
      expect(action, action).not.toMatch(/:\*$/)
      if (action.includes('*')) expect(action, action).toMatch(/:(Describe|List|Get)[A-Za-z]*\*$/)
    }
  })

  it('AC-AWS-02: IAM writes only on AscrumDemo* roles, only with the permissions boundary, and the boundary cannot be removed', () => {
    const iamWrites = allow.filter((s) =>
      actionsOf(s).some((a) => /^iam:(Create|Put|Attach)/.test(a) && a !== 'iam:CreateServiceLinkedRole'),
    )
    expect(iamWrites.map((s) => s.Sid)).toEqual(['DemoRoles'])
    const linked = allow.find((s) => actionsOf(s).includes('iam:CreateServiceLinkedRole'))
    expect(actionsOf(linked as Statement)).toEqual(['iam:CreateServiceLinkedRole'])
    expect(linked?.Condition).toEqual({
      StringEquals: {
        'iam:AWSServiceName': ['ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'rds.amazonaws.com'],
      },
    })
    const [roles] = iamWrites
    expect(json(roles?.Resource)).toContain(':role/AscrumDemo*')
    const boundaryRef = (roles?.Condition?.StringEquals?.['iam:PermissionsBoundary'] as { Ref: string }).Ref
    expect(resources(bootstrap)[boundaryRef]?.Properties?.ManagedPolicyName).toBe('ascrum-demo-role-boundary')
    const pass = allow.find((s) => actionsOf(s).includes('iam:PassRole'))
    expect(pass?.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } })
    const deny = execution.find((s) => s.Effect === 'Deny')
    expect(actionsOf(deny as Statement).sort()).toEqual([
      'iam:DeleteRolePermissionsBoundary',
      'iam:PutRolePermissionsBoundary',
    ])
    // No IAM users, groups or policies of its own.
    for (const action of allow.flatMap(actionsOf)) {
      expect(action, action).not.toMatch(/^iam:.*(User|Group|AccessKey|LoginProfile|CreatePolicy)/)
    }
  })

  it('AC-AWS-02: no permission to read any secret value', () => {
    for (const action of allow.flatMap(actionsOf)) expect(action).not.toBe('secretsmanager:GetSecretValue')
  })

  it('AC-AWS-02: the boundary allows only image pull, the API log group and RDS-managed secrets', () => {
    const boundary = managedPolicy('ascrum-demo-role-boundary')
    expect(boundary.flatMap(actionsOf).sort()).toEqual([
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetAuthorizationToken',
      'ecr:GetDownloadUrlForLayer',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
    ])
    expect(json(boundary)).toContain('secret:rds!*')
  })
})

describe('bootstrap stack: budget alarm and deploy-time values', () => {
  it('the bootstrap template fits CloudFormation’s inline limit (51,200 bytes): it is deployed before any CDK bootstrap bucket exists', () => {
    expect(JSON.stringify(bootstrap.toJSON(), null, 1).length).toBeLessThan(51_200)
  })

  it('AC-AWS-06: a monthly cost budget e-mails before the limit is passed (80 % actual, 100 % forecast)', () => {
    bootstrap.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: { Ref: 'BudgetLimitUsd' }, Unit: 'USD' },
      },
      NotificationsWithSubscribers: [
        {
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80, ThresholdType: 'PERCENTAGE' }),
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: { Ref: 'BudgetEmail' } }],
        },
        {
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: { Ref: 'BudgetEmail' } }],
        },
      ],
    })
  })

  it('AC-AWS-06: the limit and the e-mail are parameters without defaults; the e-mail is not echoed', () => {
    const parameters = (bootstrap.toJSON() as { Parameters: Record<string, Record<string, unknown>> }).Parameters
    expect(parameters.BudgetLimitUsd).toMatchObject({ Type: 'Number' })
    expect(parameters.BudgetEmail).toMatchObject({ Type: 'String', NoEcho: true })
    expect(parameters.BudgetLimitUsd).not.toHaveProperty('Default')
    expect(parameters.BudgetEmail).not.toHaveProperty('Default')
  })

  it('AC-AWS-04: everything in the bootstrap stack is tagged ascrum-env=bootstrap, so the leftover check keeps it; the stack is termination-protected', () => {
    for (const [id, resource] of Object.entries(resources(bootstrap))) {
      // Inline and managed policies cannot carry tags in CloudFormation (and are not in the tagging index).
      if (['AWS::CDK::Metadata', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)) continue
      const tags = json(resource.Properties?.Tags ?? resource.Properties?.ResourceTags)
      expect(tags, id).toContain('"ascrum-env"')
      expect(tags, id).toContain('"bootstrap"')
      expect(tags, id).toContain('"ascrum-migration"')
    }
    expect(stacks.bootstrap.terminationProtection).toBe(true)
  })

  it('spec §11: no account id, e-mail address or budget amount is written into any template', () => {
    for (const [name, template] of Object.entries(templates)) {
      const text = json(template.toJSON())
      expect(text, name).not.toMatch(/\b\d{12}\b/)
      expect(text.replace(/\^\[\^\\\\s@\]\+@\[\^\\\\s@\]\+\$/g, ''), name).not.toMatch(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      )
    }
  })
})
