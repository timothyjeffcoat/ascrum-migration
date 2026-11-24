// The one-time bootstrap (spec §11, clarified 2026-11-24): what the owner deploys once, with the owner's
// own credentials, and what the workflows never create or destroy (AC-AWS-04 keeps it).
//
//   - the GitHub OIDC provider (or an existing one, passed in: an account can only have one);
//   - the deploy role, which only this repo's deploy and destroy workflows on `migration` can assume
//     (AC-AWS-01, AC-AWS-02: no long-lived keys anywhere);
//   - the CloudFormation execution policy that `cdk bootstrap` hands to CloudFormation, so a demo
//     deploy can create what the demo stacks need and nothing else (instead of CDK's default
//     AdministratorAccess);
//   - the permissions boundary every role in the demo stacks gets;
//   - the monthly AWS Budgets alarm (AC-AWS-06). Its limit and e-mail are CloudFormation parameters
//     given at deploy time; they are never written in the repo.
//
// It is deployed with the owner's CLI credentials (CliCredentialsStackSynthesizer): it has no assets and
// needs no CDK bootstrap, which is what lets it come first. The order is in infra/README.md.
import { Aws, CfnOutput, CfnParameter, Duration, Stack, type StackProps } from 'aws-cdk-lib'
import * as budgets from 'aws-cdk-lib/aws-budgets'
import * as iam from 'aws-cdk-lib/aws-iam'
import type { Construct } from 'constructs'
import {
  CDK_QUALIFIER,
  DEMO_STACK_PREFIX,
  DEPLOY_BRANCH,
  DEPLOY_WORKFLOWS,
  GITHUB_ENVIRONMENT,
  GITHUB_REPOSITORY_PATTERN,
  NAMES,
  webBucketName,
} from './names.ts'

export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com'

export type BootstrapStackProps = StackProps & {
  /** `owner/repo` of the GitHub repository whose workflows may deploy. */
  githubRepository: string
  /** ARN of the account's existing GitHub OIDC provider; omitted, the stack creates one. */
  existingOidcProviderArn?: string
}

/**
 * The OIDC `sub` values the deploy role trusts: one per workflow file, on `migration`, in the
 * `aws-demo` environment. This is GitHub's customised subject (repo, context, job_workflow_ref), which
 * the owner turns on once for the repository (infra/README.md, Q-p5-infra-1). With the default subject
 * (`repo:<owner>/<repo>:environment:aws-demo`) the role cannot be assumed at all: it fails closed.
 */
export function trustedSubjects(githubRepository: string): string[] {
  return DEPLOY_WORKFLOWS.map(
    (workflow) =>
      `repo:${githubRepository}:environment:${GITHUB_ENVIRONMENT}` +
      `:job_workflow_ref:${githubRepository}/${workflow}@refs/heads/${DEPLOY_BRANCH}`,
  )
}

const arn = (service: string, resource: string, region: string = Aws.REGION) =>
  `arn:${Aws.PARTITION}:${service}:${region}:${Aws.ACCOUNT_ID}:${resource}`
const iamArn = (resource: string) => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:${resource}`
const sameRegion = { StringEquals: { 'aws:RequestedRegion': Aws.REGION } }

export class BootstrapStack extends Stack {
  readonly deployRole: iam.Role

  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props)
    const { githubRepository, existingOidcProviderArn } = props
    if (!GITHUB_REPOSITORY_PATTERN.test(githubRepository)) {
      throw new Error(`githubRepository must be "owner/repo", got "${githubRepository}"`)
    }
    if (
      existingOidcProviderArn !== undefined &&
      !existingOidcProviderArn.endsWith(`:oidc-provider/${GITHUB_OIDC_HOST}`)
    ) {
      throw new Error(
        `existingOidcProviderArn must be the ${GITHUB_OIDC_HOST} provider, got "${existingOidcProviderArn}"`,
      )
    }

    // --- GitHub OIDC provider ------------------------------------------------------------------------
    // The L1 resource, not iam.OpenIdConnectProvider: that one is a Lambda-backed custom resource. No
    // thumbprint: IAM trusts GitHub's certificate through its own root CAs.
    const providerArn =
      existingOidcProviderArn ??
      new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
        url: `https://${GITHUB_OIDC_HOST}`,
        clientIdList: ['sts.amazonaws.com'],
      }).attrArn

    // --- Permissions boundary for every role the demo stacks create ------------------------------------
    // The demo stacks' roles (ECS task execution and task roles) can never do more than this, whatever a
    // template says: pull the API image, write its logs, read the database secret RDS manages.
    const boundary = new iam.ManagedPolicy(this, 'DemoRoleBoundary', {
      managedPolicyName: NAMES.roleBoundary,
      description: 'Permissions boundary for every IAM role in the AscrumDemo* stacks',
      statements: [
        new iam.PolicyStatement({
          sid: 'PullApiImage',
          actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          resources: [arn('ecr', `repository/${NAMES.apiRepository}`)],
        }),
        new iam.PolicyStatement({
          sid: 'EcrLogin',
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ApiLogs',
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [arn('logs', `log-group:${NAMES.apiLogGroup}:*`)],
        }),
        new iam.PolicyStatement({
          sid: 'DatabaseSecret',
          // RDS-managed master secrets are named rds!db-<id> (manageMasterUserPassword in the demo stack).
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [arn('secretsmanager', 'secret:rds!*')],
        }),
      ],
    })

    // --- CloudFormation execution policy (cdk bootstrap --cloudformation-execution-policies) -----------
    // What CloudFormation may do while it creates and deletes the demo stacks. Read-only calls are broad
    // (Describe*/List*/Get*); every write is listed by name, limited to this region, and IAM writes are
    // limited to the stacks' own roles, which must carry the boundary above.
    const demoRoles = iamArn(`role/${DEMO_STACK_PREFIX}*`)
    const execution = new iam.ManagedPolicy(this, 'CfnExecutionPolicy', {
      managedPolicyName: NAMES.cfnExecutionPolicy,
      description: 'CloudFormation execution policy for the AscrumDemo* stacks (cdk bootstrap --qualifier ascrum)',
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadOnly',
          actions: [
            'ec2:Describe*',
            'elasticloadbalancing:Describe*',
            'ecs:Describe*',
            'ecs:List*',
            'rds:Describe*',
            'rds:ListTagsForResource',
            'logs:Describe*',
            'logs:ListTagsForResource',
            'logs:ListTagsLogGroup',
            'cloudfront:Get*',
            'cloudfront:List*',
            'cloudfront:DescribeFunction',
            'ecr:DescribeRepositories',
            'ecr:GetLifecyclePolicy',
            'ecr:ListTagsForResource',
            'secretsmanager:DescribeSecret',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'CdkBootstrapVersion',
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: [arn('ssm', `parameter/cdk-bootstrap/${CDK_QUALIFIER}/version`)],
        }),
        new iam.PolicyStatement({
          sid: 'Network',
          actions: [
            'ec2:CreateVpc',
            'ec2:DeleteVpc',
            'ec2:ModifyVpcAttribute',
            'ec2:CreateSubnet',
            'ec2:DeleteSubnet',
            'ec2:ModifySubnetAttribute',
            'ec2:CreateRouteTable',
            'ec2:DeleteRouteTable',
            'ec2:CreateRoute',
            'ec2:DeleteRoute',
            'ec2:AssociateRouteTable',
            'ec2:DisassociateRouteTable',
            'ec2:CreateInternetGateway',
            'ec2:DeleteInternetGateway',
            'ec2:AttachInternetGateway',
            'ec2:DetachInternetGateway',
            'ec2:CreateSecurityGroup',
            'ec2:DeleteSecurityGroup',
            'ec2:AuthorizeSecurityGroupIngress',
            'ec2:AuthorizeSecurityGroupEgress',
            'ec2:RevokeSecurityGroupIngress',
            'ec2:RevokeSecurityGroupEgress',
            'ec2:GetManagedPrefixListEntries',
            'ec2:CreateTags',
            'ec2:DeleteTags',
          ],
          resources: ['*'],
          conditions: sameRegion,
        }),
        new iam.PolicyStatement({
          sid: 'LoadBalancer',
          actions: [
            'elasticloadbalancing:CreateLoadBalancer',
            'elasticloadbalancing:DeleteLoadBalancer',
            'elasticloadbalancing:ModifyLoadBalancerAttributes',
            'elasticloadbalancing:SetSecurityGroups',
            'elasticloadbalancing:SetSubnets',
            'elasticloadbalancing:CreateTargetGroup',
            'elasticloadbalancing:DeleteTargetGroup',
            'elasticloadbalancing:ModifyTargetGroup',
            'elasticloadbalancing:ModifyTargetGroupAttributes',
            'elasticloadbalancing:CreateListener',
            'elasticloadbalancing:DeleteListener',
            'elasticloadbalancing:ModifyListener',
            'elasticloadbalancing:ModifyListenerAttributes',
            'elasticloadbalancing:CreateRule',
            'elasticloadbalancing:DeleteRule',
            'elasticloadbalancing:ModifyRule',
            'elasticloadbalancing:AddTags',
            'elasticloadbalancing:RemoveTags',
          ],
          resources: ['*'],
          conditions: sameRegion,
        }),
        new iam.PolicyStatement({
          sid: 'Containers',
          actions: [
            'ecs:CreateCluster',
            'ecs:DeleteCluster',
            'ecs:RegisterTaskDefinition',
            'ecs:DeregisterTaskDefinition',
            'ecs:CreateService',
            'ecs:UpdateService',
            'ecs:DeleteService',
            'ecs:TagResource',
            'ecs:UntagResource',
          ],
          resources: ['*'],
          conditions: sameRegion,
        }),
        new iam.PolicyStatement({
          sid: 'ApiRepository',
          actions: [
            'ecr:CreateRepository',
            'ecr:DeleteRepository',
            'ecr:PutImageScanningConfiguration',
            'ecr:PutImageTagMutability',
            'ecr:PutLifecyclePolicy',
            'ecr:DeleteLifecyclePolicy',
            'ecr:ListImages',
            'ecr:BatchDeleteImage',
            'ecr:TagResource',
            'ecr:UntagResource',
          ],
          resources: [arn('ecr', `repository/${NAMES.apiRepository}`)],
        }),
        new iam.PolicyStatement({
          sid: 'Database',
          actions: [
            'rds:CreateDBInstance',
            'rds:DeleteDBInstance',
            'rds:ModifyDBInstance',
            'rds:CreateDBSubnetGroup',
            'rds:DeleteDBSubnetGroup',
            'rds:ModifyDBSubnetGroup',
            'rds:AddTagsToResource',
            'rds:RemoveTagsFromResource',
          ],
          resources: ['*'],
          conditions: sameRegion,
        }),
        new iam.PolicyStatement({
          // manageMasterUserPassword: RDS creates (and deletes) the secret on the caller's behalf. Only
          // RDS-managed secrets (rds!...), and no permission to read any secret's value.
          sid: 'DatabaseManagedSecret',
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:TagResource',
            'secretsmanager:RotateSecret',
            'secretsmanager:DeleteSecret',
          ],
          resources: [arn('secretsmanager', 'secret:rds!*')],
        }),
        new iam.PolicyStatement({
          // Storage encryption and the managed secret use the AWS-managed keys (aws/rds, aws/secretsmanager),
          // and only through those two services.
          sid: 'ManagedKeysThroughRdsAndSecretsManager',
          actions: ['kms:DescribeKey', 'kms:CreateGrant'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'kms:ViaService': [`rds.${Aws.REGION}.amazonaws.com`, `secretsmanager.${Aws.REGION}.amazonaws.com`],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: 'Logs',
          actions: [
            'logs:CreateLogGroup',
            'logs:DeleteLogGroup',
            'logs:PutRetentionPolicy',
            'logs:DeleteRetentionPolicy',
            'logs:TagResource',
            'logs:UntagResource',
            'logs:TagLogGroup',
            'logs:UntagLogGroup',
          ],
          resources: [arn('logs', `log-group:${NAMES.apiLogGroup}`), arn('logs', `log-group:${NAMES.apiLogGroup}:*`)],
        }),
        new iam.PolicyStatement({
          sid: 'WebBucket',
          actions: [
            's3:CreateBucket',
            's3:DeleteBucket',
            's3:ListBucket',
            's3:GetBucket*',
            's3:GetEncryptionConfiguration',
            's3:PutBucketPolicy',
            's3:DeleteBucketPolicy',
            's3:PutBucketTagging',
            's3:PutBucketPublicAccessBlock',
            's3:PutBucketOwnershipControls',
            's3:PutEncryptionConfiguration',
            's3:PutBucketVersioning',
          ],
          resources: [`arn:${Aws.PARTITION}:s3:::${webBucketName(Aws.ACCOUNT_ID, Aws.REGION)}`],
        }),
        new iam.PolicyStatement({
          // CloudFront is global; its resources (distribution, origin access control, response headers
          // policy, viewer function) have generated ids, so they cannot be named here.
          sid: 'Cdn',
          actions: [
            'cloudfront:CreateDistribution',
            'cloudfront:CreateDistributionWithTags',
            'cloudfront:UpdateDistribution',
            'cloudfront:DeleteDistribution',
            'cloudfront:TagResource',
            'cloudfront:UntagResource',
            'cloudfront:CreateOriginAccessControl',
            'cloudfront:UpdateOriginAccessControl',
            'cloudfront:DeleteOriginAccessControl',
            'cloudfront:CreateResponseHeadersPolicy',
            'cloudfront:UpdateResponseHeadersPolicy',
            'cloudfront:DeleteResponseHeadersPolicy',
            'cloudfront:CreateFunction',
            'cloudfront:UpdateFunction',
            'cloudfront:PublishFunction',
            'cloudfront:DeleteFunction',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'DemoRoles',
          actions: [
            'iam:CreateRole',
            'iam:PutRolePolicy',
            'iam:AttachRolePolicy',
            'iam:DetachRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:TagRole',
            'iam:UntagRole',
            'iam:UpdateRoleDescription',
          ],
          resources: [demoRoles],
          conditions: { StringEquals: { 'iam:PermissionsBoundary': boundary.managedPolicyArn } },
        }),
        new iam.PolicyStatement({
          sid: 'DemoRolesReadAndDelete',
          actions: [
            'iam:GetRole',
            'iam:GetRolePolicy',
            'iam:ListRolePolicies',
            'iam:ListAttachedRolePolicies',
            'iam:DeleteRole',
          ],
          resources: [demoRoles],
        }),
        new iam.PolicyStatement({
          sid: 'PassDemoRolesToEcsTasks',
          actions: ['iam:PassRole'],
          resources: [demoRoles],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
        new iam.PolicyStatement({
          sid: 'ServiceLinkedRoles',
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'iam:AWSServiceName': ['ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'rds.amazonaws.com'],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: 'NoBoundaryEscape',
          effect: iam.Effect.DENY,
          actions: ['iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary'],
          resources: ['*'],
        }),
      ],
    })

    // --- The deploy role (assumed by the workflows through OIDC) ---------------------------------------
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: NAMES.deployRole,
      description: `GitHub Actions: deploy and destroy the AscrumDemo* stacks (${githubRepository}, ${DEPLOY_BRANCH} only)`,
      maxSessionDuration: Duration.hours(2),
      assumedBy: new iam.FederatedPrincipal(
        providerArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: trustedSubjects(githubRepository),
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    })

    const cdkRole = (kind: string) => iamArn(`role/cdk-${CDK_QUALIFIER}-${kind}-role-${Aws.ACCOUNT_ID}-${Aws.REGION}`)
    const demoStacks = arn('cloudformation', `stack/${DEMO_STACK_PREFIX}*/*`)
    const bucket = `arn:${Aws.PARTITION}:s3:::${webBucketName(Aws.ACCOUNT_ID, Aws.REGION)}`
    const repository = arn('ecr', `repository/${NAMES.apiRepository}`)
    const statements = [
      new iam.PolicyStatement({
        // `cdk deploy`: CDK's own deploy role (which hands the template to CloudFormation with the
        // execution policy above) and the role that uploads the template to the bootstrap bucket.
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [cdkRole('deploy'), cdkRole('file-publishing')],
      }),
      new iam.PolicyStatement({
        sid: 'EcrLogin',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        // Push the API image, then read the scan-on-push result (spec §6 image-scan, Q-p5-7).
        sid: 'PushApiImageAndReadItsScan',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
          'ecr:BatchGetImage',
          'ecr:DescribeImages',
          'ecr:DescribeImageScanFindings',
        ],
        resources: [repository],
      }),
      new iam.PolicyStatement({
        // Upload the web build, and empty the bucket before the stack is deleted.
        sid: 'WebBuild',
        actions: ['s3:ListBucket'],
        resources: [bucket],
      }),
      new iam.PolicyStatement({
        sid: 'WebBuildObjects',
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [`${bucket}/*`],
      }),
      new iam.PolicyStatement({
        // Read outputs and events, and delete the demo stacks directly (destroy works without a synth,
        // also after a half-finished deploy). CloudFormation deletes with the stack's own execution role.
        sid: 'DemoStacks',
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:ListStackResources',
          'cloudformation:CancelUpdateStack',
          'cloudformation:DeleteStack',
        ],
        resources: [demoStacks],
      }),
      new iam.PolicyStatement({
        // The CloudFront prefix list for the load balancer's security group, and the final leftover check
        // (AC-AWS-04): list tagged resources, then ask the services whether the ones the tagging index
        // still shows really exist.
        sid: 'ReadOnlyChecks',
        actions: [
          'ec2:DescribeManagedPrefixLists',
          'tag:GetResources',
          'ecs:DescribeClusters',
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'secretsmanager:DescribeSecret',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        // The API's logs, kept in the evidence when the smoke test fails.
        sid: 'ReadApiLogs',
        actions: ['logs:FilterLogEvents', 'logs:DescribeLogStreams'],
        resources: [arn('logs', `log-group:${NAMES.apiLogGroup}:*`)],
      }),
    ]
    for (const statement of statements) this.deployRole.addToPrincipalPolicy(statement)

    // --- Budget alarm (AC-AWS-06) -----------------------------------------------------------------------
    const limit = new CfnParameter(this, 'BudgetLimitUsd', {
      type: 'Number',
      minValue: 1,
      description: 'Monthly cost limit in USD (AC-AWS-06). Set at deploy time; never written in the repo.',
    })
    const email = new CfnParameter(this, 'BudgetEmail', {
      type: 'String',
      noEcho: true,
      allowedPattern: '^[^\\s@]+@[^\\s@]+$',
      description: 'Where the budget alarm is sent (AC-AWS-06). Set at deploy time; never written in the repo.',
    })
    const subscribers = [{ subscriptionType: 'EMAIL', address: email.valueAsString }]
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: NAMES.budget,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: limit.valueAsNumber, unit: 'USD' },
        // The whole account, not a cost-allocation tag: a tag filter shows $0 until the owner activates
        // the tag in Billing (up to 24 h), so it could stay silent (Q-p5-infra-4).
      },
      notificationsWithSubscribers: [
        // Before the limit is passed: when the actual cost reaches 80 %, and when the month's forecast
        // passes 100 %.
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
      // Tagged project / ascrum-env=bootstrap like the rest of this stack (src/app.ts), so the final
      // leftover check recognises it as the budget that stays.
    })

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'GitHub environment secret AWS_DEPLOY_ROLE_ARN',
    })
    new CfnOutput(this, 'CfnExecutionPolicyArn', {
      value: execution.managedPolicyArn,
      description: 'cdk bootstrap --cloudformation-execution-policies',
    })
    new CfnOutput(this, 'RoleBoundaryArn', { value: boundary.managedPolicyArn })
  }
}
