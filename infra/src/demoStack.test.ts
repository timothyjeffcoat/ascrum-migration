import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { Match } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { securityHeaders } from '../../web/securityHeaders.ts'
import { PLACEHOLDER } from './app.ts'
import { API_START_SCRIPT, SPA_FALLBACK_FUNCTION } from './demoStack.ts'
import { ofType, resources, synth, type Resource } from './testApp.ts'

const DEPLOY = {
  demoDeploy: 'true',
  imageTag: 'f42e1765d32ea1aa4f05fc15a4a9ac08bf6f83f6',
  originSecret: 'testoriginsecret'.repeat(4),
  cloudFrontPrefixListId: 'pl-3b927c52',
}
const { templates, stacks } = synth(DEPLOY)
const demo = templates.demo
const registry = templates.registry
const all = resources(demo)

const ref = (value: unknown) => (value as { Ref?: string }).Ref
const getAtt = (value: unknown) => (value as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt']?.[0]
const one = (type: string): [string, Resource] => {
  const found = ofType(demo, type)
  expect(found, type).toHaveLength(1)
  return found[0] as [string, Resource]
}
const securityGroupId = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'GroupId'] })

describe('demo stack: the database is not reachable from the internet', () => {
  const [dbId, db] = one('AWS::RDS::DBInstance')
  const props = db.Properties ?? {}

  it('AC-AWS-05: RDS is not publicly accessible and lives in subnets with no route to the internet', () => {
    expect(props.PubliclyAccessible).toBe(false)
    const group = all[ref(props.DBSubnetGroupName) ?? '']
    const subnets = (group?.Properties?.SubnetIds as unknown[]).map(ref)
    expect(subnets).toHaveLength(2)
    for (const subnet of subnets) {
      expect(all[subnet ?? '']?.Properties?.MapPublicIpOnLaunch, subnet).toBe(false)
      const association = Object.values(all).find(
        (r) => r.Type === 'AWS::EC2::SubnetRouteTableAssociation' && ref(r.Properties?.SubnetId) === subnet,
      )
      const table = ref(association?.Properties?.RouteTableId)
      const routes = Object.values(all).filter(
        (r) => r.Type === 'AWS::EC2::Route' && ref(r.Properties?.RouteTableId) === table,
      )
      expect(routes, `${subnet}: routes`).toEqual([])
    }
    demo.resourceCountIs('AWS::EC2::NatGateway', 0)
    demo.resourceCountIs('AWS::EC2::VPCEndpoint', 0)
  })

  it('AC-AWS-05: the database security group admits PostgreSQL from the API tasks only, and no address range', () => {
    const dbSg = getAtt((props.VPCSecurityGroups as unknown[])[0])
    const ingress = Object.values(all).filter(
      (r) => r.Type === 'AWS::EC2::SecurityGroupIngress' && getAtt(r.Properties?.GroupId) === dbSg,
    )
    expect(ingress).toHaveLength(1)
    const [rule] = ingress
    expect(rule?.Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 })
    expect(getAtt(rule?.Properties?.SourceSecurityGroupId)).toMatch(/^ApiSg/)
    expect(JSON.stringify(all[dbSg ?? '']?.Properties?.SecurityGroupIngress ?? [])).toBe('[]')
  })

  it('AC-AWS-05 / S-p5-4: the password is generated and kept by RDS (no password in the template)', () => {
    expect(props.ManageMasterUserPassword).toBe(true)
    expect(props).not.toHaveProperty('MasterUserPassword')
    demo.resourceCountIs('AWS::SecretsManager::Secret', 0)
    expect(props.StorageEncrypted).toBe(true)
    expect(dbId).toMatch(/^Database/)
  })
})

describe('demo stack: only CloudFront reaches the API', () => {
  it('§3.6: the load balancer admits CloudFront’s origin-facing prefix list only, on port 80', () => {
    const ingress = ofType(demo, 'AWS::EC2::SecurityGroupIngress')
      .map(([, r]) => r.Properties ?? {})
      .filter((p) => getAtt(p.GroupId)?.startsWith('LoadBalancerSg'))
    expect(ingress).toEqual([
      expect.objectContaining({ SourcePrefixListId: DEPLOY.cloudFrontPrefixListId, FromPort: 80, ToPort: 80 }),
    ])
    for (const [, sg] of ofType(demo, 'AWS::EC2::SecurityGroup')) {
      for (const rule of (sg.Properties?.SecurityGroupIngress as Record<string, unknown>[] | undefined) ?? []) {
        expect(rule.CidrIp).toBeUndefined()
      }
    }
  })

  it('§3.6 (R30): no security group admits any address range, IPv4 or IPv6, inline or as a separate rule', () => {
    const inline = ofType(demo, 'AWS::EC2::SecurityGroup').flatMap(
      ([, sg]) => (sg.Properties?.SecurityGroupIngress as Record<string, unknown>[] | undefined) ?? [],
    )
    const separate = ofType(demo, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties ?? {})
    expect(inline).toEqual([])
    for (const rule of separate) {
      expect(rule).not.toHaveProperty('CidrIp')
      expect(rule).not.toHaveProperty('CidrIpv6')
      expect(Boolean(rule.SourceSecurityGroupId) || Boolean(rule.SourcePrefixListId)).toBe(true)
    }
    expect(JSON.stringify(demo.toJSON())).not.toContain('::/0')
  })

  it('§3.6: without the per-run origin header, the listener answers 403; with it, it forwards to the API', () => {
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '403' }) }),
      ],
    })
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: [DEPLOY.originSecret] },
        },
      ],
      Actions: [Match.objectLike({ Type: 'forward' })],
    })
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      ]),
    })
  })

  it('§3.6: the API tasks admit the load balancer only; outbound is HTTPS and the database', () => {
    const [apiSgId, apiSg] = ofType(demo, 'AWS::EC2::SecurityGroup').find(([id]) => id.startsWith('ApiSg')) ?? []
    expect(apiSg?.Properties?.SecurityGroupEgress).toEqual([
      expect.objectContaining({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443 }),
    ])
    const ingress = ofType(demo, 'AWS::EC2::SecurityGroupIngress')
      .map(([, r]) => r.Properties ?? {})
      .filter((p) => JSON.stringify(p.GroupId) === JSON.stringify(securityGroupId(apiSgId ?? '')))
    expect(ingress).toHaveLength(1)
    expect(getAtt(ingress[0]?.SourceSecurityGroupId)).toMatch(/^LoadBalancerSg/)
  })

  it('§3.6: CloudFront sends the contract paths to the API uncached, with cookies and query strings, HTTPS only', () => {
    const [, distribution] = one('AWS::CloudFront::Distribution')
    const config = distribution.Properties?.DistributionConfig as {
      DefaultCacheBehavior: Record<string, unknown>
      CacheBehaviors: Record<string, unknown>[]
      Origins: { Id: string; CustomOriginConfig?: Record<string, unknown>; OriginCustomHeaders?: unknown[] }[]
    }
    expect(config.CacheBehaviors.map((b) => b.PathPattern)).toEqual([
      '/login',
      '/logout',
      '/current-user',
      '/databases/*',
      '/__stub/*',
    ])
    for (const behavior of config.CacheBehaviors) {
      expect(behavior).toMatchObject({
        ViewerProtocolPolicy: 'https-only',
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
        OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3', // Managed-AllViewer
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      })
    }
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https')
    const api = config.Origins.find((o) => o.CustomOriginConfig)
    expect(api?.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'http-only' })
    expect(api?.OriginCustomHeaders).toEqual([{ HeaderName: 'X-Origin-Verify', HeaderValue: DEPLOY.originSecret }])
  })

  it('§3.6: the web bucket is private: all public access blocked, TLS only, read by CloudFront through OAC', () => {
    demo.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
    demo.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1)
    const [, policy] = one('AWS::S3::BucketPolicy')
    const text = JSON.stringify(policy.Properties)
    expect(text).toContain('aws:SecureTransport')
    expect(text).toContain('cloudfront.amazonaws.com')
    expect(text).not.toMatch(/"Principal":"\*","Action":"s3:GetObject"/)
  })
})

describe('demo stack: the API container', () => {
  const [, taskDefinition] = one('AWS::ECS::TaskDefinition')
  const [container] = taskDefinition.Properties?.ContainerDefinitions as Record<string, unknown>[]
  const environment = Object.fromEntries(
    (container?.Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]),
  )

  it('AC-SEC-02 / AC-SEC-03 (deployed): production mode, no reset route, two trusted proxies (CloudFront, ALB)', () => {
    expect(environment.APP_ENV).toBe('production')
    expect(environment.TRUST_PROXY_HOPS).toBe('2')
    expect(environment).not.toHaveProperty('ALLOW_RESET')
    expect(environment).not.toHaveProperty('DATABASE_URL')
  })

  it('S-p5-4: the database credentials come from the RDS-managed secret, never from the environment', () => {
    const secrets = container?.Secrets as { Name: string; ValueFrom: unknown }[]
    expect(secrets.map((s) => s.Name).sort()).toEqual(['DB_PASSWORD', 'DB_USERNAME'])
    for (const secret of secrets) expect(JSON.stringify(secret.ValueFrom)).toContain('MasterUserSecret.SecretArn')
  })

  it('the image is the commit’s tag in the scanned repository; read-only root filesystem; init process', () => {
    expect(JSON.stringify(container?.Image)).toContain(`/ascrum-demo-api:${DEPLOY.imageTag}`)
    expect(container?.ReadonlyRootFilesystem).toBe(true)
    expect(container?.LinuxParameters).toMatchObject({ InitProcessEnabled: true })
    demo.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: false } }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }) },
    })
  })

  it('S-p5-4: the start script builds DATABASE_URL in the container, percent-encoding any password', () => {
    const password = `p@ss:w/rd%41#?&"'$\`!*()[]{}<>|\\;= ~`
    const script = API_START_SCRIPT.replace('exec node api/src/main.ts', 'printf %s "$DATABASE_URL"')
    expect(script).not.toBe(API_START_SCRIPT)
    const url = execFileSync('sh', ['-c', script], {
      env: {
        PATH: process.env.PATH,
        DB_HOST: 'db.example.internal',
        DB_PORT: '5432',
        DB_NAME: 'ascrum',
        DB_USERNAME: 'ascrum',
        DB_PASSWORD: password,
      },
      encoding: 'utf8',
    })
    const parsed = new URL(url)
    expect(decodeURIComponent(parsed.password)).toBe(password)
    expect(decodeURIComponent(parsed.username)).toBe('ascrum')
    expect(parsed.hostname).toBe('db.example.internal')
    expect(parsed.port).toBe('5432')
    expect(parsed.pathname).toBe('/ascrum')
    expect(parsed.searchParams.get('sslmode')).toBe('no-verify')
    expect(API_START_SCRIPT).toMatch(/&& exec node api\/src\/main\.ts$/)
  })

  it('AC-AWS-02: every role the demo stacks create carries the boundary and can be assumed by ECS tasks only', () => {
    for (const template of [demo, registry]) {
      for (const [id, role] of ofType(template, 'AWS::IAM::Role')) {
        expect(JSON.stringify(role.Properties?.PermissionsBoundary), id).toContain(':policy/ascrum-demo-role-boundary')
        expect(role.Properties?.AssumeRolePolicyDocument, id).toEqual({
          Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }],
          Version: '2012-10-17',
        })
      }
    }
  })
})

describe('demo stack: S-p5-5 headers on CloudFront', () => {
  const [, policy] = one('AWS::CloudFront::ResponseHeadersPolicy')
  const config = policy.Properties?.ResponseHeadersPolicyConfig as {
    SecurityHeadersConfig: Record<string, Record<string, unknown>>
    CustomHeadersConfig: { Items: { Header: string; Value: string }[] }
  }

  it('AC-SEC-05 (deployed): the response headers policy is web/securityHeaders.ts, plus HSTS', () => {
    const security = config.SecurityHeadersConfig
    expect(security.ContentSecurityPolicy?.ContentSecurityPolicy).toBe(securityHeaders['Content-Security-Policy'])
    expect(security.ContentTypeOptions).toEqual({ Override: true })
    expect(security.ReferrerPolicy?.ReferrerPolicy).toBe(securityHeaders['Referrer-Policy'])
    expect(security.FrameOptions?.FrameOption).toBe(securityHeaders['X-Frame-Options'])
    expect(security.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 31536000, Override: true })
    const custom = Object.fromEntries(config.CustomHeadersConfig.Items.map((h) => [h.Header, h.Value]))
    expect(custom).toEqual({
      'Cross-Origin-Opener-Policy': securityHeaders['Cross-Origin-Opener-Policy'],
      'Permissions-Policy': securityHeaders['Permissions-Policy'],
    })
    // Every behaviour (web and API) sends them, as nginx does for every response.
    const [, distribution] = one('AWS::CloudFront::Distribution')
    const text = JSON.stringify(distribution.Properties)
    const behaviours = 1 + 5
    expect(text.match(/"ResponseHeadersPolicyId"/g)).toHaveLength(behaviours)
  })

  it('the SPA fallback serves index.html for client-side routes and leaves files alone', () => {
    const handler = runInNewContext(`${SPA_FALLBACK_FUNCTION}; handler`) as (event: unknown) => { uri: string }
    const rewrite = (uri: string) => handler({ request: { uri } }).uri
    expect(rewrite('/')).toBe('/index.html')
    expect(rewrite('/projects')).toBe('/index.html')
    expect(rewrite('/projects/200000000000000000000001/sprints/new')).toBe('/index.html')
    expect(rewrite('/assets/index-abc123.js')).toBe('/assets/index-abc123.js')
    expect(rewrite('/favicon.ico')).toBe('/favicon.ico')
  })
})

describe('demo stacks: destroy and leftovers', () => {
  it('AC-AWS-04: nothing is retained or snapshotted, deletion protection is off, the repository empties itself', () => {
    for (const template of [demo, registry]) {
      for (const [id, resource] of Object.entries(resources(template))) {
        expect(resource.DeletionPolicy ?? 'Delete', id).toBe('Delete')
        expect(resource.UpdateReplacePolicy ?? 'Delete', id).toBe('Delete')
      }
    }
    demo.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: false,
      BackupRetentionPeriod: 0,
      DeleteAutomatedBackups: true,
    })
    demo.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'deletion_protection.enabled', Value: 'false' }]),
    })
    registry.hasResourceProperties('AWS::ECR::Repository', { EmptyOnDelete: true })
    expect(stacks.demo.terminationProtection).toBe(false)
    expect(stacks.registry.terminationProtection).toBe(false)
  })

  it('AC-AWS-04: no Lambda or custom resource that a destroy would depend on, no always-billed extras', () => {
    for (const template of [demo, registry]) {
      const types = Object.values(resources(template)).map((r) => r.Type)
      expect(types.filter((t) => t.startsWith('Custom::') || t === 'AWS::CloudFormation::CustomResource')).toEqual([])
      for (const type of ['AWS::Lambda::Function', 'AWS::EC2::NatGateway', 'AWS::EC2::VPCEndpoint', 'AWS::EC2::EIP']) {
        expect(types).not.toContain(type)
      }
    }
  })

  it('AC-AWS-04: every taggable resource is tagged project=ascrum-migration and ascrum-env=demo', () => {
    const mustBeTagged = [
      'AWS::EC2::VPC',
      'AWS::EC2::Subnet',
      'AWS::EC2::SecurityGroup',
      'AWS::RDS::DBInstance',
      'AWS::ECS::Cluster',
      'AWS::ECS::Service',
      'AWS::ECS::TaskDefinition',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::S3::Bucket',
      'AWS::Logs::LogGroup',
      'AWS::CloudFront::Distribution',
      'AWS::ECR::Repository',
      'AWS::IAM::Role',
    ]
    for (const template of [demo, registry]) {
      for (const [id, resource] of Object.entries(resources(template))) {
        const tags = resource.Properties?.Tags
        if (!mustBeTagged.includes(resource.Type) && tags === undefined) continue
        const text = JSON.stringify(tags)
        expect(text, `${id} (${resource.Type})`).toContain('{"Key":"project","Value":"ascrum-migration"}')
        expect(text, `${id} (${resource.Type})`).toContain('{"Key":"ascrum-env","Value":"demo"}')
      }
    }
    // The ECS service hands its tags to the tasks it starts.
    demo.hasResourceProperties('AWS::ECS::Service', { PropagateTags: 'SERVICE' })
  })
})

describe('demo stacks: synth without AWS', () => {
  it('stacks are environment-agnostic: synth needs no account, no region and no lookups', () => {
    for (const stack of [stacks.demo, stacks.registry, stacks.bootstrap]) {
      expect(stack.environment).toBe('aws://unknown-account/unknown-region')
    }
    // CDK writes the result of a lookup into the stack's missing-context list; there must be none.
    expect(JSON.stringify(stacks.demo.node.metadata)).not.toContain('missing')
  })

  it('a placeholder synth works offline, and a real deploy refuses to use placeholders', () => {
    const placeholder = synth().templates.demo
    placeholder.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      SourcePrefixListId: PLACEHOLDER.cloudFrontPrefixListId,
    })
    expect(() => synth({ demoDeploy: 'true' })).toThrow(/imageTag is required/)
    expect(() => synth({ ...DEPLOY, originSecret: 'short' })).toThrow(/originSecret/)
    expect(() => synth({ ...DEPLOY, cloudFrontPrefixListId: 'sg-123' })).toThrow(/prefix list/)
  })
})
