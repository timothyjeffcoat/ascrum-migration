import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { buildStacks } from './app.ts'
import { EXECUTION_POLICY_PARTS, subjectPrefix } from './bootstrapStack.ts'
import { NAMES } from './names.ts'
import { actionsOf, ofType, resources, synth, TEST_REPOSITORY, type Resource, type Statement } from './testApp.ts'
import { templateYaml } from './testYaml.ts'

const { templates, stacks, assembly } = synth()
const bootstrap = templates.bootstrap

/** A resource or condition value as one string: Refs become ${Name}, GetAtts ${Logical.Attr}. */
function flat(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return `[${value.map(flat).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if ('Ref' in object) return `\${${String(object.Ref)}}`
    if ('Fn::GetAtt' in object) return `\${${(object['Fn::GetAtt'] as string[]).join('.')}}`
    if ('Fn::Join' in object) {
      const [separator, parts] = object['Fn::Join'] as [string, unknown[]]
      return parts.map(flat).join(separator)
    }
  }
  return JSON.stringify(value)
}
const resourcesOf = (statement: Statement): string[] =>
  (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]).map(flat)

const ARN = (service: string, resource: string) =>
  `arn:\${AWS::Partition}:${service}:\${AWS::Region}:\${AWS::AccountId}:${resource}`
const IAM = (resource: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:${resource}`

function roleNamed(name: string): [string, Resource] {
  const found = ofType(bootstrap, 'AWS::IAM::Role').find(([, r]) => r.Properties?.RoleName === name)
  if (!found) throw new Error(`no role ${name}`)
  return found
}
const [deployRoleId, deployRole] = roleNamed('ascrum-github-deploy')
const [executionRoleId, executionRole] = roleNamed('ascrum-cfn-exec')

function deployRolePolicy(): Statement[] {
  const found = ofType(bootstrap, 'AWS::IAM::Policy').filter(([, r]) =>
    flat(r.Properties?.Roles).includes(`\${${deployRoleId}}`),
  )
  expect(found).toHaveLength(1) // the role's only policy: nothing attached elsewhere
  return (found[0]?.[1].Properties?.PolicyDocument as { Statement: Statement[] }).Statement
}

function managedPolicy(name: string): [string, Statement[]] {
  const found = ofType(bootstrap, 'AWS::IAM::ManagedPolicy').find(([, r]) => r.Properties?.ManagedPolicyName === name)
  if (!found) throw new Error(`no managed policy ${name}`)
  return [found[0], (found[1].Properties?.PolicyDocument as { Statement: Statement[] }).Statement]
}

const json = (value: unknown) => JSON.stringify(value)
const isRead = (action: string) => /:(Describe|Get|List)[A-Za-z]*\*?$/.test(action)
/** Whether an action pattern of a policy (wildcards allowed) grants the action. */
const grantsAction = (pattern: string, action: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(action)

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
    const role = deployRole
    const trust = (role.Properties?.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement
    expect(trust).toHaveLength(1)
    const [statement] = trust
    expect(statement?.Action).toBe('sts:AssumeRoleWithWebIdentity')
    expect(statement?.Effect).toBe('Allow')
    expect(Object.keys(statement?.Condition ?? {})).toEqual(['StringEquals']) // no StringLike, no wildcards
    expect(statement?.Condition?.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': [
        'repo:example-owner@123456/ascrum-migration@456789:environment:aws-demo:job_workflow_ref:example-owner/ascrum-migration/.github/workflows/deploy-demo.yml@refs/heads/migration',
        'repo:example-owner@123456/ascrum-migration@456789:environment:aws-demo:job_workflow_ref:example-owner/ascrum-migration/.github/workflows/destroy-demo.yml@refs/heads/migration',
      ],
    })
    expect(json(statement)).not.toContain('*')
    expect(role.Properties?.MaxSessionDuration).toBe(7200)
  })

  it('Q-p5-infra-11: the trust is GitHub’s immutable subject only (owner and repository ids), never the name-only form', () => {
    const subjects = flat(deployRole.Properties?.AssumeRolePolicyDocument)
    expect(subjects).not.toContain(`repo:${TEST_REPOSITORY}:`)
    expect(subjects).not.toMatch(/[*?]/)
    // The repo segment is what GitHub's read-back calls sub_claim_prefix; the stack outputs it to compare.
    const prefix = 'repo:example-owner@123456/ascrum-migration@456789'
    expect(
      subjectPrefix({ githubRepository: TEST_REPOSITORY, githubOwnerId: '123456', githubRepositoryId: '456789' }),
    ).toBe(prefix)
    bootstrap.hasOutput('OidcSubjectPrefix', { Value: prefix })
  })

  it('Q-p5-infra-11: the owner and repository ids are required, digits only (a wildcard or text would widen or break the trust)', () => {
    for (const key of ['githubOwnerId', 'githubRepositoryId']) {
      for (const bad of ['*', '12*', '', 'abc', '0123', '12 34', '-1', '1.5']) {
        expect(() => synth({ [key]: bad }), `${key}=${bad}`).toThrow(key)
      }
    }
    expect(() => buildStacks(new App({ context: { githubRepository: TEST_REPOSITORY } }), {})).toThrow(
      /githubOwnerId and githubRepositoryId/,
    )
    expect(() =>
      buildStacks(new App({ context: { githubRepository: TEST_REPOSITORY, githubOwnerId: '123456' } }), {}),
    ).toThrow(/githubOwnerId and githubRepositoryId/)
    // In a workflow, GitHub's own variables supply them.
    const fromEnv = buildStacks(new App({ context: { githubRepository: TEST_REPOSITORY } }), {
      GITHUB_REPOSITORY_OWNER_ID: '123456',
      GITHUB_REPOSITORY_ID: '456789',
    })
    Template.fromStack(fromEnv.bootstrap).hasOutput('OidcSubjectPrefix', {
      Value: 'repo:example-owner@123456/ascrum-migration@456789',
    })
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

  it('AC-AWS-02 / DEV-p5-infra-01: the deploy role assumes no role; its one IAM action passes the execution role to CloudFormation', () => {
    const statements = deployRolePolicy()
    const allow = statements.filter((s) => s.Effect === 'Allow')
    const actions = allow.flatMap(actionsOf)
    expect(actions.filter((a) => a.startsWith('sts:'))).toEqual([])
    expect(actions.filter((a) => a.startsWith('iam:'))).toEqual(['iam:PassRole'])
    const pass = allow.find((s) => actionsOf(s).includes('iam:PassRole')) as Statement
    expect(resourcesOf(pass)).toEqual([`\${${executionRoleId}.Arn}`])
    expect(pass.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } })
    for (const action of actions) expect(action, action).not.toMatch(/\*/)
  })

  it('DEV-p5-infra-01: every CloudFormation call is on AscrumDemo* stacks, and a change set only hands CloudFormation the execution role', () => {
    const allow = deployRolePolicy().filter((s) => s.Effect === 'Allow')
    const cfn = allow.filter((s) => actionsOf(s).some((a) => a.startsWith('cloudformation:')))
    for (const statement of cfn) {
      expect(
        actionsOf(statement).every((a) => a.startsWith('cloudformation:')),
        statement.Sid,
      ).toBe(true)
      expect(resourcesOf(statement), statement.Sid).toEqual([ARN('cloudformation', 'stack/AscrumDemo*/*')])
    }
    const create = cfn.find((s) => actionsOf(s).includes('cloudformation:CreateChangeSet')) as Statement
    expect(actionsOf(create)).toEqual(['cloudformation:CreateChangeSet'])
    expect(create.Condition).toEqual({
      StringEquals: { 'cloudformation:RoleArn': { 'Fn::GetAtt': [executionRoleId, 'Arn'] } },
    })
    const all = cfn.flatMap(actionsOf)
    for (const never of [
      'cloudformation:CreateStack',
      'cloudformation:UpdateStack',
      'cloudformation:UpdateTerminationProtection',
      'cloudformation:SetStackPolicy',
      'cloudformation:CreateStackRefactor',
      'cloudformation:ExecuteStackRefactor',
    ]) {
      expect(all).not.toContain(never)
    }
  })

  it('DEV-p5-infra-01: explicit denies: no termination protection or stack policy change anywhere, nothing on the bootstrap or a CDK toolkit stack', () => {
    const deny = deployRolePolicy().filter((s) => s.Effect === 'Deny')
    const protection = deny.find((s) => s.Sid === 'NeverProtectionOrBootstrap') as Statement
    expect(actionsOf(protection).sort()).toEqual([
      'cloudformation:CreateStackRefactor',
      'cloudformation:ExecuteStackRefactor',
      'cloudformation:SetStackPolicy',
      'cloudformation:UpdateTerminationProtection',
    ])
    expect(protection.Resource).toBe('*')
    const stacksDeny = deny.find((s) => s.Sid === 'NeverTheBootstrapStacks') as Statement
    expect(actionsOf(stacksDeny)).toEqual(['cloudformation:*'])
    expect(resourcesOf(stacksDeny)).toEqual([
      ARN('cloudformation', 'stack/AscrumBootstrap/*'),
      ARN('cloudformation', 'stack/CDKToolkit*/*'),
    ])
    expect(deny.filter((s) => s.Condition !== undefined).map((s) => s.Sid)).toEqual(['NeverImportResources'])
  })

  it('DEV-p5-infra-10: no change set may import an existing resource into a demo stack', () => {
    const deny = deployRolePolicy().filter((s) => s.Effect === 'Deny')
    const imports = deny.find((s) => s.Sid === 'NeverImportResources') as Statement
    expect(actionsOf(imports)).toEqual(['cloudformation:CreateChangeSet'])
    expect(imports.Resource).toBe('*')
    expect(imports.Condition).toEqual({ Null: { 'cloudformation:ImportResourceTypes': 'false' } })
  })

  it('DEV-p5-infra-01: the execution role is trusted by CloudFormation only and holds only the execution policy parts', () => {
    const trust = (executionRole.Properties?.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement
    expect(trust).toEqual([
      { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' } },
    ])
    const policyIds = EXECUTION_POLICY_PARTS.map((part) => managedPolicy(`ascrum-cdk-cfn-execution-${part}`)[0])
    expect(executionRole.Properties?.ManagedPolicyArns).toEqual(policyIds.map((id) => ({ Ref: id })))
    expect(executionRole.Properties?.Policies).toBeUndefined()
    const inline = ofType(bootstrap, 'AWS::IAM::Policy').filter(([, r]) =>
      flat(r.Properties?.Roles).includes(`\${${executionRoleId}}`),
    )
    expect(inline).toEqual([])
  })

  it('DEV-p5-infra-01: no CDK bootstrap: no stack names a role to assume, an asset bucket or a bootstrap version; the demo stacks name the execution role', () => {
    for (const stack of [stacks.bootstrap, stacks.registry, stacks.demo]) {
      const artifact = assembly.getStackByName(stack.stackName)
      expect(artifact.assumeRoleArn, stack.stackName).toBeUndefined()
      expect(artifact.lookupRole, stack.stackName).toBeUndefined()
      expect(artifact.stackTemplateAssetObjectUrl, stack.stackName).toBeUndefined()
      expect(artifact.requiresBootstrapStackVersion, stack.stackName).toBeUndefined()
      expect(artifact.assets, stack.stackName).toEqual([])
    }
    expect(assembly.getStackByName('AscrumBootstrap').cloudFormationExecutionRoleArn).toBeUndefined()
    for (const name of ['AscrumDemoRegistry', 'AscrumDemo']) {
      expect(assembly.getStackByName(name).cloudFormationExecutionRoleArn, name).toBe(
        'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/ascrum-cfn-exec',
      )
    }
    expect(executionRole.Properties?.RoleName).toBe(NAMES.cfnExecutionRole)
    for (const template of Object.values(templates)) {
      expect(json(template.toJSON())).not.toContain('BootstrapVersion')
      expect(json(template.toJSON())).not.toMatch(/cdk-[a-z0-9]+-(deploy|cfn-exec|file-publishing|lookup)-role/)
    }
  })

  it('AC-AWS-02: the deploy role, action by action and resource by resource (R24, R25)', () => {
    const allow = deployRolePolicy().filter((s) => s.Effect === 'Allow')
    const bucket = 'arn:${AWS::Partition}:s3:::ascrum-demo-web-${AWS::AccountId}-${AWS::Region}'
    const repository = ARN('ecr', 'repository/ascrum-demo-api')
    const demoStacks = ARN('cloudformation', 'stack/AscrumDemo*/*')
    const expected: Record<string, [string[], string[]]> = {
      CreateDemoChangeSets: [['cloudformation:CreateChangeSet'], [demoStacks]],
      DemoStacks: [
        [
          'cloudformation:CancelUpdateStack',
          'cloudformation:DeleteChangeSet',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeChangeSet',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:DescribeStacks',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:GetTemplate',
          'cloudformation:ListStackResources',
          'cloudformation:TagResource',
          'cloudformation:UntagResource',
        ],
        [demoStacks],
      ],
      PassExecutionRoleToCloudFormation: [['iam:PassRole'], [`\${${executionRoleId}.Arn}`]],
      EcrLogin: [['ecr:GetAuthorizationToken'], ['*']],
      PushApiImageAndReadItsScan: [
        [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImageScanFindings',
          'ecr:DescribeImages',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:StartImageScan',
          'ecr:UploadLayerPart',
        ],
        [repository],
      ],
      WebBuild: [['s3:ListBucket'], [bucket]],
      WebBuildObjects: [['s3:DeleteObject', 's3:GetObject', 's3:PutObject'], [`${bucket}/*`]],
      ReadOnlyChecks: [
        [
          'ec2:DescribeManagedPrefixLists',
          'ecs:DescribeClusters',
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'secretsmanager:DescribeSecret',
          'tag:GetResources',
        ],
        ['*'],
      ],
      ReadApiLogs: [
        ['logs:DescribeLogStreams', 'logs:FilterLogEvents'],
        [ARN('logs', 'log-group:/ascrum/demo/api'), ARN('logs', 'log-group:/ascrum/demo/api:*')],
      ],
    }
    expect(Object.fromEntries(allow.map((s) => [s.Sid, [actionsOf(s).sort(), resourcesOf(s)]]))).toEqual(expected)
    // R24: never a secret's value; R25: object writes only in the web bucket.
    expect(allow.flatMap(actionsOf)).not.toContain('secretsmanager:GetSecretValue')
  })
})

describe('bootstrap stack: what CloudFormation may do for the demo stacks', () => {
  // The execution policy is split by size (policyLimits.test.ts); these tests read the union of its parts.
  const execution = EXECUTION_POLICY_PARTS.flatMap((part) => managedPolicy(`ascrum-cdk-cfn-execution-${part}`)[1])
  const allow = execution.filter((s) => s.Effect === 'Allow')
  const sid = (name: string) => {
    const found = allow.find((s) => s.Sid === name)
    if (!found) throw new Error(`no statement ${name}`)
    return found
  }
  const region = { 'aws:RequestedRegion': { Ref: 'AWS::Region' } }

  it('AC-AWS-02: no "*" or "service:*" action; writes are listed one by one', () => {
    for (const action of allow.flatMap(actionsOf)) {
      expect(action, action).not.toBe('*')
      expect(action, action).not.toMatch(/:\*$/)
      if (action.includes('*')) expect(action, action).toMatch(/:(Describe|List|Get)[A-Za-z]*\*$/)
    }
  })

  it('AC-AWS-02 / DEV-p5-infra-05 (R27): the execution policy is exactly this allow-list, statement by statement', () => {
    const expected: Record<string, string[]> = {
      ReadOnly: [
        'cloudfront:DescribeFunction',
        'cloudfront:Get*',
        'cloudfront:List*',
        'ec2:Describe*',
        'ecr:DescribeRepositories',
        'ecr:GetLifecyclePolicy',
        'ecr:ListTagsForResource',
        'ecs:Describe*',
        'ecs:List*',
        'elasticloadbalancing:Describe*',
        'logs:Describe*',
        'logs:ListTagsForResource',
        'logs:ListTagsLogGroup',
        'rds:Describe*',
        'rds:ListTagsForResource',
        'secretsmanager:DescribeSecret',
      ],
      NetworkCreateTagged: ['ec2:CreateInternetGateway', 'ec2:CreateVpc'],
      NetworkCreateInDemoVpc: ['ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:CreateSubnet'],
      NetworkCreateChildTagged: ['ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:CreateSubnet'],
      NetworkPrefixLists: ['ec2:GetManagedPrefixListEntries'],
      LoadBalancerEc2Reads: ['ec2:GetSecurityGroupsForVpc', 'ec2:ValidateSecurityGroupQuotasForInterface'],
      NetworkTagOnCreate: ['ec2:CreateTags'],
      NetworkChangeTagged: [
        'ec2:AssociateRouteTable',
        'ec2:AttachInternetGateway',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:CreateRoute',
        'ec2:CreateTags',
        'ec2:DeleteInternetGateway',
        'ec2:DeleteRoute',
        'ec2:DeleteRouteTable',
        'ec2:DeleteSecurityGroup',
        'ec2:DeleteSubnet',
        'ec2:DeleteTags',
        'ec2:DeleteVpc',
        'ec2:DetachInternetGateway',
        'ec2:DisassociateRouteTable',
        'ec2:ModifySubnetAttribute',
        'ec2:ModifyVpcAttribute',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
      ],
      LoadBalancer: [
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:ModifyListenerAttributes',
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:ModifyRule',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:RemoveTags',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
      ],
      Containers: [
        'ecs:CreateCluster',
        'ecs:CreateService',
        'ecs:DeleteCluster',
        'ecs:DeleteService',
        'ecs:TagResource',
        'ecs:UntagResource',
        'ecs:UpdateService',
      ],
      RegisterDemoTaskDefinition: ['ecs:RegisterTaskDefinition'],
      DeregisterTaskDefinitions: ['ecs:DeregisterTaskDefinition'],
      ApiRepository: [
        'ecr:BatchDeleteImage',
        'ecr:CreateRepository',
        'ecr:DeleteLifecyclePolicy',
        'ecr:DeleteRepository',
        'ecr:ListImages',
        'ecr:PutImageScanningConfiguration',
        'ecr:PutImageTagMutability',
        'ecr:PutLifecyclePolicy',
        'ecr:TagResource',
        'ecr:UntagResource',
      ],
      Database: [
        'rds:AddTagsToResource',
        'rds:CreateDBInstance',
        'rds:CreateDBSubnetGroup',
        'rds:DeleteDBInstance',
        'rds:DeleteDBSubnetGroup',
        'rds:ModifyDBInstance',
        'rds:ModifyDBSubnetGroup',
        'rds:RemoveTagsFromResource',
      ],
      DatabaseManagedSecret: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:RotateSecret',
        'secretsmanager:TagResource',
      ],
      ManagedKeysThroughRdsAndSecretsManager: ['kms:CreateGrant', 'kms:DescribeKey'],
      Logs: [
        'logs:CreateLogGroup',
        'logs:DeleteLogGroup',
        'logs:DeleteRetentionPolicy',
        'logs:PutRetentionPolicy',
        'logs:TagLogGroup',
        'logs:TagResource',
        'logs:UntagLogGroup',
        'logs:UntagResource',
      ],
      WebBucket: [
        's3:CreateBucket',
        's3:DeleteBucket',
        's3:DeleteBucketPolicy',
        's3:Get*',
        's3:ListBucket',
        's3:ListTagsForResource',
        's3:PutBucketOwnershipControls',
        's3:PutBucketPolicy',
        's3:PutBucketPublicAccessBlock',
        's3:PutBucketTagging',
        's3:PutBucketVersioning',
        's3:PutEncryptionConfiguration',
        's3:TagResource',
        's3:UntagResource',
      ],
      CdnFunction: [
        'cloudfront:CreateFunction',
        'cloudfront:DeleteFunction',
        'cloudfront:PublishFunction',
        'cloudfront:UpdateFunction',
      ],
      CdnDistributionCreate: ['cloudfront:CreateDistribution', 'cloudfront:TagResource'],
      CdnDistributionChangeTagged: [
        'cloudfront:DeleteDistribution',
        'cloudfront:UntagResource',
        'cloudfront:UpdateDistribution',
      ],
      CdnUnscopable: [
        'cloudfront:CreateOriginAccessControl',
        'cloudfront:CreateResponseHeadersPolicy',
        'cloudfront:DeleteOriginAccessControl',
        'cloudfront:DeleteResponseHeadersPolicy',
        'cloudfront:UpdateOriginAccessControl',
        'cloudfront:UpdateResponseHeadersPolicy',
      ],
      DemoRoles: ['iam:AttachRolePolicy', 'iam:CreateRole', 'iam:DetachRolePolicy', 'iam:PutRolePolicy'],
      DemoRolesTagReadAndDelete: [
        'iam:DeleteRole',
        'iam:DeleteRolePolicy',
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:ListInstanceProfilesForRole',
        'iam:ListRolePolicies',
        'iam:ListRoleTags',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:UpdateRoleDescription',
      ],
      PassDemoRolesToEcsTasks: ['iam:PassRole'],
      ServiceLinkedRoles: ['iam:CreateServiceLinkedRole'],
    }
    expect(Object.fromEntries(allow.map((s) => [s.Sid, actionsOf(s).sort()]))).toEqual(expected)
  })

  it('DEV-p5-infra-05/-10: a write on "*" only with its condition: region, tag-on-create, the demo tag in the request, a service; only origin access controls and response headers policies have none', () => {
    const conditioned: Record<string, unknown> = {
      NetworkTagOnCreate: {
        StringEquals: {
          ...region,
          // Bare API names: the "ec2:"-prefixed values of #69 never matched (live run 4).
          'ec2:CreateAction': [
            'CreateVpc',
            'CreateSubnet',
            'CreateRouteTable',
            'CreateInternetGateway',
            'CreateSecurityGroup',
          ],
          'aws:RequestTag/project': 'ascrum-migration',
        },
      },
      NetworkChangeTagged: { StringEquals: { ...region, 'aws:ResourceTag/project': 'ascrum-migration' } },
      DeregisterTaskDefinitions: { StringEquals: region },
      CdnDistributionCreate: { StringEquals: { 'aws:RequestTag/project': 'ascrum-migration' } },
      ManagedKeysThroughRdsAndSecretsManager: {
        StringEquals: {
          'kms:ViaService': [
            { 'Fn::Join': ['', ['rds.', { Ref: 'AWS::Region' }, '.amazonaws.com']] },
            { 'Fn::Join': ['', ['secretsmanager.', { Ref: 'AWS::Region' }, '.amazonaws.com']] },
          ],
        },
      },
      ServiceLinkedRoles: {
        StringEquals: {
          'iam:AWSServiceName': ['ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'rds.amazonaws.com'],
        },
      },
    }
    const onStar = allow.filter((s) => s.Resource === '*' && !actionsOf(s).every(isRead))
    expect(onStar.map((s) => s.Sid).sort()).toEqual([...Object.keys(conditioned), 'CdnUnscopable'].sort())
    for (const statement of onStar) {
      if (statement.Sid === 'CdnUnscopable') {
        expect(
          actionsOf(statement).every((a) => /^cloudfront:\w+(OriginAccessControl|ResponseHeadersPolicy)$/.test(a)),
        ).toBe(true)
        continue
      }
      expect(statement.Condition, statement.Sid).toEqual(conditioned[statement.Sid ?? ''])
    }
  })

  it('DEV-p5-infra-10: a CloudFront distribution is created only with the demo tag and changed, deleted or untagged only when it carries it', () => {
    const create = sid('CdnDistributionCreate')
    expect(actionsOf(create).sort()).toEqual(['cloudfront:CreateDistribution', 'cloudfront:TagResource'])
    expect(create.Condition).toEqual({ StringEquals: { 'aws:RequestTag/project': 'ascrum-migration' } })
    const change = sid('CdnDistributionChangeTagged')
    expect(resourcesOf(change)).toEqual(['arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*'])
    expect(change.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/project': 'ascrum-migration' } })
    // No other statement grants a distribution write, and none names CreateDistributionWithTags: that is
    // an API operation, which IAM authorises as CreateDistribution plus TagResource (worklog).
    const distributionWrites = allow.filter((s) =>
      actionsOf(s).some((a) => /^cloudfront:(\w+Distribution\w*|TagResource|UntagResource)$/.test(a) && !isRead(a)),
    )
    expect(distributionWrites.map((s) => s.Sid).sort()).toEqual([
      'CdnDistributionChangeTagged',
      'CdnDistributionCreate',
    ])
    // The demo's distribution carries the tag the conditions ask for.
    templates.demo.hasResourceProperties('AWS::CloudFront::Distribution', {
      Tags: Match.arrayWith([{ Key: 'project', Value: 'ascrum-migration' }]),
    })
  })

  it('DEV-p5-infra-10: task definitions are registered only in the demo family', () => {
    expect(resourcesOf(sid('RegisterDemoTaskDefinition'))).toEqual([ARN('ecs', 'task-definition/ascrum-demo-api:*')])
    expect(sid('RegisterDemoTaskDefinition').Condition).toBeUndefined()
  })

  it('DEV-p5-infra-05 (R26): every EC2 write is region-bound; deletes and changes need the demo tag, and the tag can only be set while creating', () => {
    const ec2Writes = allow.filter((s) => actionsOf(s).some((a) => a.startsWith('ec2:') && !isRead(a)))
    // ValidateSecurityGroupQuotasForInterface is a read (Service Authorization Reference) that isRead's
    // Describe/Get/List pattern does not recognise.
    expect(ec2Writes.map((s) => s.Sid).sort()).toEqual([
      'LoadBalancerEc2Reads',
      'NetworkChangeTagged',
      'NetworkCreateChildTagged',
      'NetworkCreateInDemoVpc',
      'NetworkCreateTagged',
      'NetworkTagOnCreate',
    ])
    for (const statement of ec2Writes) {
      expect(statement.Condition?.StringEquals?.['aws:RequestedRegion'], statement.Sid).toEqual({ Ref: 'AWS::Region' })
    }
    const changes = actionsOf(sid('NetworkChangeTagged'))
    for (const action of ec2Writes.flatMap(actionsOf)) {
      if (/^ec2:(Delete|Modify|Revoke|Detach|Disassociate|Authorize|Attach|Associate)/.test(action)) {
        expect(changes, action).toContain(action)
      }
    }
    expect(actionsOf(sid('NetworkTagOnCreate'))).toEqual(['ec2:CreateTags'])
  })

  // Live run 5: Elastic Load Balancing called ec2:GetSecurityGroupsForVpc as CloudFormation's role and was
  // refused. It and ValidateSecurityGroupQuotasForInterface take a tagged VPC / security group.
  it('live run 5: the EC2 reads Elastic Load Balancing makes while creating the load balancer are allowed, on the demo-tagged VPC and security groups only', () => {
    for (const action of ['ec2:GetSecurityGroupsForVpc', 'ec2:ValidateSecurityGroupQuotasForInterface']) {
      const granting = allow.filter((s) => actionsOf(s).some((pattern) => grantsAction(pattern, action)))
      expect(
        granting.map((s) => s.Sid),
        action,
      ).toEqual(['LoadBalancerEc2Reads'])
    }
    const reads = sid('LoadBalancerEc2Reads')
    expect(resourcesOf(reads).sort()).toEqual([ARN('ec2', 'security-group/*'), ARN('ec2', 'vpc/*')])
    expect(reads.Condition).toEqual({
      StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' }, 'aws:ResourceTag/project': 'ascrum-migration' },
    })
  })

  // Security review of #82, sec-02: the old check (/^ec2:Create/) let ec2:CreateTags through.
  it('sec-02: ec2:CreateTags is allowed only on a resource being created (ec2:CreateAction, with the demo tag in the request) or on one that already carries the demo tag', () => {
    const tagging = allow.filter((s) => actionsOf(s).some((a) => grantsAction(a, 'ec2:CreateTags')))
    expect(tagging.length).toBeGreaterThan(0)
    for (const statement of tagging) {
      const equals = statement.Condition?.StringEquals ?? {}
      const onCreate =
        equals['ec2:CreateAction'] !== undefined && equals['aws:RequestTag/project'] === 'ascrum-migration'
      const onTagged = equals['aws:ResourceTag/project'] === 'ascrum-migration'
      expect(onCreate || onTagged, statement.Sid).toBe(true)
    }
  })

  // Security review of #82, sec-01: a subnet, route table or security group is created inside an existing
  // VPC, and IAM checks that VPC too. Before the split, NetworkCreate allowed them in any VPC.
  it('sec-01: a subnet, route table or security group is created only in a VPC carrying the demo tag, and only with the demo tag in the request; a VPC or internet gateway only with the demo tag in the request', () => {
    const children = ['ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup']
    const parents = ['ec2:CreateVpc', 'ec2:CreateInternetGateway']
    const vpc = ARN('ec2', 'vpc/*')
    const childArns = [ARN('ec2', 'subnet/*'), ARN('ec2', 'security-group/*'), ARN('ec2', 'route-table/*')]
    const grantsAny = (s: Statement, actions: string[]) =>
      actionsOf(s).some((pattern) => actions.some((action) => grantsAction(pattern, action)))
    const requestTagged = (s: Statement) => s.Condition?.StringEquals?.['aws:RequestTag/project'] === 'ascrum-migration'
    const resourceTagged = (s: Statement) =>
      s.Condition?.StringEquals?.['aws:ResourceTag/project'] === 'ascrum-migration'
    for (const statement of allow.filter((s) => grantsAny(s, children))) {
      const on = resourcesOf(statement)
      expect(on, statement.Sid).not.toContain('*')
      if (on.includes(vpc)) {
        // The parent VPC: exactly vpc/*, and only when it carries the demo tag.
        expect(on, statement.Sid).toEqual([vpc])
        expect(resourceTagged(statement), statement.Sid).toBe(true)
      } else {
        // The new child: only its own resource types, and only requested with the demo tag.
        expect(
          on.every((r) => childArns.includes(r)),
          statement.Sid,
        ).toBe(true)
        expect(requestTagged(statement), statement.Sid).toBe(true)
      }
    }
    // Both sides are granted, so a child create needs both: a tagged VPC and the tag in the request.
    expect(allow.filter((s) => grantsAny(s, children) && resourcesOf(s).includes(vpc)).map((s) => s.Sid)).toEqual([
      'NetworkCreateInDemoVpc',
    ])
    expect(allow.filter((s) => grantsAny(s, children) && !resourcesOf(s).includes(vpc)).map((s) => s.Sid)).toEqual([
      'NetworkCreateChildTagged',
    ])
    for (const statement of allow.filter((s) => grantsAny(s, parents))) {
      expect(resourcesOf(statement), statement.Sid).not.toContain('*')
      expect(requestTagged(statement), statement.Sid).toBe(true)
    }
    expect(allow.filter((s) => grantsAny(s, parents)).map((s) => s.Sid)).toEqual(['NetworkCreateTagged'])
  })

  it('DEV-p5-infra-05: load balancer, ECS, RDS and the CloudFront function by name only; the demo stack uses exactly those names', () => {
    const lb = (resource: string) => ARN('elasticloadbalancing', resource)
    expect(resourcesOf(sid('LoadBalancer')).sort()).toEqual([
      lb('listener-rule/app/ascrum-demo/*'),
      lb('listener/app/ascrum-demo/*'),
      lb('loadbalancer/app/ascrum-demo/*'),
      lb('targetgroup/ascrum-demo-api/*'),
    ])
    expect(resourcesOf(sid('Containers')).sort()).toEqual([
      ARN('ecs', 'cluster/ascrum-demo'),
      ARN('ecs', 'service/ascrum-demo/*'),
      ARN('ecs', 'task-definition/ascrum-demo-api:*'),
    ])
    expect(resourcesOf(sid('Database')).sort()).toEqual([
      ARN('rds', 'db:ascrum-demo-db'),
      ARN('rds', 'og:default:postgres-*'),
      ARN('rds', 'pg:default.postgres*'),
      ARN('rds', 'subgrp:ascrum-demo-db'),
    ])
    expect(resourcesOf(sid('CdnFunction'))).toEqual([
      'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:function/ascrum-demo-spa-fallback',
    ])
    const demo = templates.demo
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Name: NAMES.loadBalancer })
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Name: NAMES.targetGroup })
    demo.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: NAMES.cluster })
    demo.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: NAMES.taskFamily })
    demo.hasResourceProperties('AWS::ECS::Service', { Cluster: { Ref: Match.anyValue() } })
    demo.hasResourceProperties('AWS::RDS::DBInstance', { DBInstanceIdentifier: NAMES.dbInstance })
    demo.hasResourceProperties('AWS::RDS::DBSubnetGroup', { DBSubnetGroupName: NAMES.dbSubnetGroup })
    demo.hasResourceProperties('AWS::CloudFront::Function', { Name: NAMES.spaFunction })
  })

  it('AC-AWS-02: IAM writes only on AscrumDemo* roles, only with the permissions boundary, and the boundary cannot be removed', () => {
    const iamWrites = allow.filter((s) =>
      actionsOf(s).some((a) => /^iam:(Create|Put|Attach)/.test(a) && a !== 'iam:CreateServiceLinkedRole'),
    )
    expect(iamWrites.map((s) => s.Sid)).toEqual(['DemoRoles'])
    const [roles] = iamWrites
    expect(resourcesOf(roles as Statement)).toEqual([IAM('role/AscrumDemo*')])
    const boundaryRef = (roles?.Condition?.StringEquals?.['iam:PermissionsBoundary'] as { Ref: string }).Ref
    expect(resources(bootstrap)[boundaryRef]?.Properties?.ManagedPolicyName).toBe('ascrum-demo-role-boundary')
    const deny = execution.find((s) => s.Effect === 'Deny')
    expect(actionsOf(deny as Statement).sort()).toEqual([
      'iam:DeleteRolePermissionsBoundary',
      'iam:PutRolePermissionsBoundary',
    ])
    // Every IAM action is on the demo roles, except the three service-linked roles.
    for (const statement of allow.filter((s) => actionsOf(s).some((a) => a.startsWith('iam:')))) {
      if (statement.Sid === 'ServiceLinkedRoles') continue
      expect(resourcesOf(statement), statement.Sid).toEqual([IAM('role/AscrumDemo*')])
    }
    for (const action of allow.flatMap(actionsOf)) {
      expect(action, action).not.toMatch(/^iam:.*(User|Group|AccessKey|LoginProfile|CreatePolicy)/)
    }
  })

  it('AC-AWS-02 (R17): iam:PassRole only for the demo roles and only to ECS tasks; never on "*"', () => {
    const pass = allow.filter((s) => actionsOf(s).includes('iam:PassRole'))
    expect(pass.map((s) => s.Sid)).toEqual(['PassDemoRolesToEcsTasks'])
    expect(actionsOf(pass[0] as Statement)).toEqual(['iam:PassRole'])
    expect(resourcesOf(pass[0] as Statement)).toEqual([IAM('role/AscrumDemo*')])
    expect(pass[0]?.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } })
  })

  it('DEV-p5-infra-04: tag, describe-change and instance-profile calls on demo roles carry no boundary condition (IAM gives them no such key)', () => {
    const boundaryOnly = actionsOf(sid('DemoRoles'))
    for (const action of [
      'iam:TagRole',
      'iam:UntagRole',
      'iam:UpdateRoleDescription',
      'iam:ListInstanceProfilesForRole',
    ]) {
      expect(boundaryOnly).not.toContain(action)
      expect(actionsOf(sid('DemoRolesTagReadAndDelete'))).toContain(action)
    }
    expect(sid('DemoRolesTagReadAndDelete').Condition).toBeUndefined()
    // The bucket handler's configuration reads: every Get* on the one web bucket, never its objects.
    expect(resourcesOf(sid('WebBucket'))).toEqual([
      'arn:${AWS::Partition}:s3:::ascrum-demo-web-${AWS::AccountId}-${AWS::Region}',
    ])
  })

  it('AC-AWS-02: no permission to read any secret value', () => {
    for (const action of allow.flatMap(actionsOf)) expect(action).not.toBe('secretsmanager:GetSecretValue')
  })

  it('AC-AWS-02: the boundary allows only image pull, the API log group and RDS-managed secrets', () => {
    const [, boundary] = managedPolicy('ascrum-demo-role-boundary')
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

  it('DEV-p5-infra-10: the boundary reads only the demo DB’s RDS-managed secret, by the instance ARN RDS tags it with', () => {
    const [, boundary] = managedPolicy('ascrum-demo-role-boundary')
    const secret = boundary.find((s) => s.Sid === 'DatabaseSecret') as Statement
    expect(actionsOf(secret).sort()).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'])
    expect(resourcesOf(secret)).toEqual([ARN('secretsmanager', 'secret:rds!*')])
    expect(Object.keys(secret.Condition ?? {})).toEqual(['StringEquals'])
    const owner = secret.Condition?.StringEquals ?? {}
    expect(Object.keys(owner)).toEqual(['aws:ResourceTag/aws:rds:primaryDBInstanceArn'])
    expect(flat(owner['aws:ResourceTag/aws:rds:primaryDBInstanceArn'])).toBe(ARN('rds', 'db:ascrum-demo-db'))
    templates.demo.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: NAMES.dbInstance,
      ManageMasterUserPassword: true,
    })
  })
})

describe('bootstrap stack: budget alarm and deploy-time values', () => {
  it('DEV-p5-infra-01: every template fits CloudFormation’s inline limit (51,200 bytes) as the CLI sends it, so no staging bucket is needed', () => {
    // The CLI sends YAML (yaml 2, lineWidth 0); the bundled serialiser folds lines differently, so 4 KiB spare.
    for (const [name, template] of Object.entries(templates)) {
      expect(templateYaml(template.toJSON()).length, name).toBeLessThan(51_200 - 4_096)
      expect(JSON.stringify(template.toJSON(), null, 1).length, name).toBeLessThan(51_200)
    }
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
