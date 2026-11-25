// How CloudFormation tags each resource type of the AscrumDemo stack, and which statement of the
// execution policy (bootstrapStack.ts) allows it. Live run 4 failed on tagging (UnauthorizedTaggingOperation
// on the VPC and the internet gateway), which review #69 had left as "provable only live"; this table is
// the analysis it skipped, made per type so that a new type cannot be added without it
// (demoTagging.test.ts compares it with the synthesised template).
//
// Source for every row: the type's CloudFormation registry schema (`tagging` and
// `handlers.create.permissions`; CloudformationSchema.zip, read 2026-11-25) and the service's API or IAM
// documentation where the schema lists more than one way to tag (worklog, 2026-11-25, live run 4).

export type TaggingRow = {
  /** `create`: the schema says taggable and tagOnCreate, and the template gives it tags. */
  tagging: 'create' | 'none'
  /** The tagging actions the create path is authorised for, beyond the create call itself. */
  actions: string[]
  /** The execution-policy statements that allow them. */
  statements: string[]
  note?: string
}

const network = (resource: string): TaggingRow => ({
  tagging: 'create',
  actions: ['ec2:CreateTags'],
  statements: ['NetworkTagOnCreate'],
  note: `Tags go in the Create${resource} TagSpecifications; EC2 then authorises ec2:CreateTags with ec2:CreateAction = "Create${resource}" (no "ec2:" prefix: live run 4).`,
})
const none = (note?: string): TaggingRow => ({
  tagging: 'none',
  actions: [],
  statements: [],
  ...(note ? { note } : {}),
})

export const DEMO_TAGGING: Record<string, TaggingRow> = {
  'AWS::CDK::Metadata': none('CDK bookkeeping; no AWS resource.'),
  'AWS::CloudFront::Distribution': {
    tagging: 'create',
    actions: ['cloudfront:CreateDistribution', 'cloudfront:TagResource'],
    statements: ['CdnDistributionCreate'],
    note: 'CreateDistributionWithTags is authorised as CreateDistribution plus TagResource, with the demo tag in the request.',
  },
  'AWS::CloudFront::Function': {
    tagging: 'create',
    actions: ['cloudfront:TagResource'],
    statements: ['CdnDistributionCreate'],
    note: 'TagResource on "*" only with the demo tag in the request (the statement serves both types).',
  },
  'AWS::CloudFront::OriginAccessControl': none('Not taggable.'),
  'AWS::CloudFront::ResponseHeadersPolicy': none('Not taggable.'),
  'AWS::EC2::InternetGateway': network('InternetGateway'),
  'AWS::EC2::Route': none('Not taggable.'),
  'AWS::EC2::RouteTable': network('RouteTable'),
  'AWS::EC2::SecurityGroup': network('SecurityGroup'),
  'AWS::EC2::SecurityGroupEgress': none('Not taggable.'),
  'AWS::EC2::SecurityGroupIngress': none('Not taggable.'),
  'AWS::EC2::Subnet': network('Subnet'),
  'AWS::EC2::SubnetRouteTableAssociation': none('Not taggable.'),
  'AWS::EC2::VPC': network('Vpc'),
  'AWS::EC2::VPCGatewayAttachment': none('Not taggable.'),
  'AWS::ECS::Cluster': { tagging: 'create', actions: ['ecs:TagResource'], statements: ['Containers'] },
  'AWS::ECS::Service': { tagging: 'create', actions: ['ecs:TagResource'], statements: ['Containers'] },
  'AWS::ECS::TaskDefinition': { tagging: 'create', actions: ['ecs:TagResource'], statements: ['Containers'] },
  'AWS::ElasticLoadBalancingV2::Listener': {
    tagging: 'create',
    actions: ['elasticloadbalancing:AddTags'],
    statements: ['LoadBalancer'],
  },
  'AWS::ElasticLoadBalancingV2::ListenerRule': {
    tagging: 'create',
    actions: ['elasticloadbalancing:AddTags'],
    statements: ['LoadBalancer'],
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    tagging: 'create',
    actions: ['elasticloadbalancing:AddTags'],
    statements: ['LoadBalancer'],
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    tagging: 'create',
    actions: ['elasticloadbalancing:AddTags'],
    statements: ['LoadBalancer'],
  },
  'AWS::IAM::Policy': none('Not taggable.'),
  'AWS::IAM::Role': {
    tagging: 'create',
    actions: ['iam:TagRole', 'iam:ListRoleTags'],
    statements: ['DemoRolesTagReadAndDelete'],
    note: 'The schema lists iam:ListRoleTags among the tagging permissions; it was missing before live run 4.',
  },
  'AWS::Logs::LogGroup': { tagging: 'create', actions: ['logs:TagResource'], statements: ['Logs'] },
  'AWS::RDS::DBInstance': { tagging: 'create', actions: ['rds:AddTagsToResource'], statements: ['Database'] },
  'AWS::RDS::DBSubnetGroup': { tagging: 'create', actions: ['rds:AddTagsToResource'], statements: ['Database'] },
  'AWS::S3::Bucket': {
    tagging: 'create',
    actions: ['s3:TagResource', 's3:PutBucketTagging', 's3:ListTagsForResource'],
    statements: ['WebBucket'],
    note: 'CreateBucket with Tags needs s3:TagResource (S3 API reference); it was missing before live run 4.',
  },
  'AWS::S3::BucketPolicy': none('Not taggable.'),
}
