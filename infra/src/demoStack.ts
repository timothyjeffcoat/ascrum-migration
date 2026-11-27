// The `demo` environment (spec §3.6, Q-p5-4 (a)): created by a deploy run, smoke-tested, and deleted by
// the same run (rev 2: nothing stays up). One origin for the app and the API:
//
//   viewer ──HTTPS──▶ CloudFront ─┬─ /login /logout /current-user /databases/* /__stub/* ──HTTP──▶ ALB ──▶ ECS Fargate (API) ──TLS──▶ RDS PostgreSQL
//                                 └─ everything else ──OAC──▶ S3 (the `vite build` output)
//
// Design choices (each in the worklog, the costly ones also in Q-p5-infra-*):
//   - No NAT gateway, no VPC endpoints: the API task runs in a public subnet with a public address, so it
//     can reach ECR, Secrets Manager and CloudWatch Logs; its security group accepts nothing but the load
//     balancer on port 3000. The database is in isolated subnets (no route to the internet at all) and
//     accepts only the API's security group (AC-AWS-05).
//   - The load balancer is reachable from CloudFront only: its security group admits CloudFront's
//     origin-facing prefix list, and its listener forwards only requests that carry a per-run secret
//     header CloudFront adds; anything else gets 403. That is also what makes TRUST_PROXY_HOPS=2 right
//     (p5-security's note): CloudFront appends the viewer's address, the ALB appends CloudFront's.
//   - CloudFront → ALB is HTTP: without a domain of our own there is no certificate for the ALB
//     (Q-p5-infra-2).
//   - Everything is deletable by CloudFormation alone: no deletion protection, no snapshots, no retained
//     resources, no Lambda-backed custom resources. The web bucket is emptied by the destroy script.
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import { securityHeaders } from '../../web/securityHeaders.ts'
import { API_PATH_PATTERNS, NAMES, ORIGIN_VERIFY_HEADER, webBucketName } from './names.ts'
import { responseHeadersFromMap } from './securityHeadersPolicy.ts'

export const API_PORT = 3000
export const DB_NAME = 'ascrum'
export const DB_USER = 'ascrum'

export type DemoStackProps = StackProps & {
  /** Tag of the API image in the registry stack's repository (the commit SHA). */
  imageTag: string
  /** Per-run random value CloudFront sends and the load balancer requires. */
  originSecret: string
  /** Id of the region's `com.amazonaws.global.cloudfront.origin-facing` managed prefix list. */
  cloudFrontPrefixListId: string
}

/**
 * The API container's start command. DATABASE_URL (api/src/config.ts) is built from the RDS-managed
 * secret at start, inside the container, so the password never appears in the task definition or the
 * template. Each part is percent-encoded (the generated password may contain any punctuation).
 * sslmode=no-verify: RDS requires TLS (rds.force_ssl), and the image has no RDS CA bundle to verify the
 * server against, so the connection is encrypted but the certificate is not checked (Q-p5-infra-3).
 * `exec` keeps `node api/src/main.ts` as the process the init process signals (DEV-p5-security-16).
 */
export const API_START_SCRIPT = [
  'export DATABASE_URL="$(node -e \'',
  'const e = process.env, u = new URL("postgres://localhost");',
  'u.hostname = e.DB_HOST; u.port = e.DB_PORT;',
  'u.username = encodeURIComponent(e.DB_USERNAME); u.password = encodeURIComponent(e.DB_PASSWORD);',
  'u.pathname = "/" + e.DB_NAME; u.searchParams.set("sslmode", "no-verify");',
  'process.stdout.write(u.href)',
  '\')" && exec node api/src/main.ts',
].join(' ')

/** SPA fallback (docker/web/default.conf.template `try_files $uri /index.html`) as a CloudFront Function. */
export const SPA_FALLBACK_FUNCTION = `function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  // A path whose last segment has a file extension is a file of the build (a missing one stays a miss,
  // as nginx's /assets/ rule); anything else is a client-side route and gets the app.
  if (!/\\.[A-Za-z0-9]+$/.test(last)) {
    request.uri = '/index.html';
  }
  return request;
}`

export class DemoStack extends Stack {
  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props)
    const { imageTag, originSecret, cloudFrontPrefixListId } = props
    if (!/^pl-[0-9a-f]+$/.test(cloudFrontPrefixListId)) {
      throw new Error(`cloudFrontPrefixListId must be a prefix list id (pl-...), got "${cloudFrontPrefixListId}"`)
    }
    if (!/^[A-Za-z0-9]{32,}$/.test(originSecret)) {
      throw new Error('originSecret must be at least 32 letters or digits')
    }

    // --- Network ------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // The default security group's rules are not removed: that is a Lambda-backed custom resource, and
      // nothing in this VPC uses the default group (every resource below has its own).
      restrictDefaultSecurityGroup: false,
    })

    const albSg = new ec2.SecurityGroup(this, 'LoadBalancerSg', {
      vpc,
      description: 'Demo ALB: HTTP from CloudFront origin-facing addresses only',
      allowAllOutbound: false,
    })
    albSg.addIngressRule(ec2.Peer.prefixList(cloudFrontPrefixListId), ec2.Port.tcp(80), 'CloudFront only')

    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'Demo API tasks: port 3000 from the ALB only',
      allowAllOutbound: false,
    })
    // AWS APIs (ECR, Secrets Manager, CloudWatch Logs) over HTTPS, through the internet gateway.
    apiSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS APIs over HTTPS')

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'Demo database: PostgreSQL from the API tasks only',
      allowAllOutbound: false,
    })

    albSg.addEgressRule(apiSg, ec2.Port.tcp(API_PORT), 'to the API tasks')
    apiSg.addIngressRule(albSg, ec2.Port.tcp(API_PORT), 'from the ALB')
    apiSg.addEgressRule(dbSg, ec2.Port.tcp(5432), 'to the database')
    dbSg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'from the API tasks')

    // --- Database (AC-AWS-05: isolated subnets, not publicly accessible) --------------------------------
    // Fixed names (src/names.ts) wherever an ARN carries one: the execution policy names these ARNs
    // instead of "*" (DEV-p5-infra-05).
    const dbSubnets = new rds.SubnetGroup(this, 'DatabaseSubnets', {
      subnetGroupName: NAMES.dbSubnetGroup,
      description: 'Demo database: isolated subnets (no route out)',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: RemovalPolicy.DESTROY,
    })
    const db = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: NAMES.dbInstance,
      // Q-p5-2: the newest major RDS offers generally, as compose.yaml and CI use (PostgreSQL 18).
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      subnetGroup: dbSubnets,
      securityGroups: [dbSg],
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName: DB_NAME,
      // RDS generates the password and keeps it in a Secrets Manager secret it owns and deletes with the
      // instance; nothing in the template or the repo ever holds it (S-p5-4).
      credentials: rds.Credentials.fromUsername(DB_USER),
      manageMasterUserPassword: true,
      // A throwaway environment: no backups, no final snapshot, nothing that blocks deletion.
      backupRetention: Duration.days(0),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      enablePerformanceInsights: false,
      autoMinorVersionUpgrade: true,
    })
    const dbSecretArn = (db.node.defaultChild as rds.CfnDBInstance).attrMasterUserSecretSecretArn
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'DatabaseSecret', dbSecretArn)

    // --- API on ECS Fargate ---------------------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: NAMES.cluster,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    })
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: NAMES.apiLogGroup,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      family: NAMES.taskFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })
    const repository = ecr.Repository.fromRepositoryName(this, 'ApiRepository', NAMES.apiRepository)
    // The ECS twin of compose's `init: true`: a stop does not wait for the timeout (p5-containers note).
    const linuxParameters = new ecs.LinuxParameters(this, 'ApiLinux', { initProcessEnabled: true })
    // No Linux capabilities at all (Q-p5-image-host-3 (a), DEV-p5-image-scan-14's run-time half): the API
    // runs as uid 1000 on port 3000, so it needs none, and with an empty bounding set a file capability or
    // a setuid binary that slipped past docker/check-images.sh cannot give a process root. The init process
    // ECS injects only reaps children and forwards signals to the same user's process, which needs none.
    linuxParameters.dropCapabilities(ecs.Capability.ALL)
    taskDefinition.addContainer('api', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      entryPoint: ['sh', '-c'],
      command: [API_START_SCRIPT],
      environment: {
        PORT: String(API_PORT),
        // Production mode: Secure cookies, no reset route (api/src/config.ts, AC-SEC-02/03).
        APP_ENV: 'production',
        // CloudFront appends the viewer's address, the ALB appends CloudFront's (p5-security worklog).
        TRUST_PROXY_HOPS: '2',
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_PORT: db.dbInstanceEndpointPort,
        DB_NAME,
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      portMappings: [{ containerPort: API_PORT }],
      readonlyRootFilesystem: true,
      linuxParameters,
      // The image's own check (docker/api.Dockerfile, AC-CTR-03); ECS ignores HEALTHCHECK.
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(3),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
    })

    const service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiSg],
      // A task that never becomes healthy fails the deploy after ECS's threshold instead of leaving
      // CloudFormation waiting for hours; the run then goes straight to destroy.
      circuitBreaker: { enable: true, rollback: false },
      healthCheckGracePeriod: Duration.seconds(120),
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      enableECSManagedTags: true,
    })

    // --- Load balancer (reachable from CloudFront only) ---------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: NAMES.loadBalancer,
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
      deletionProtection: false,
    })
    const listener = alb.addListener('Http', {
      port: 80,
      open: false, // the security group above decides who may connect, not a 0.0.0.0/0 rule
      defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
    })
    const targets = new elbv2.ApplicationTargetGroup(this, 'ApiTargets', {
      targetGroupName: NAMES.targetGroup,
      vpc,
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      // GET /healthz answers 503 while the database is down (AC-CTR-03), so every target goes unhealthy
      // together in an outage and the ALB fails open to all of them; acceptable for a demo that lives for
      // minutes (p5-containers' note).
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: Duration.seconds(10),
        healthyThresholdCount: 2,
      },
      deregistrationDelay: Duration.seconds(5),
    })
    listener.addAction('FromCloudFront', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originSecret])],
      action: elbv2.ListenerAction.forward([targets]),
    })

    // --- Web build on S3, behind CloudFront ------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: webBucketName(this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      // The destroy script empties it first (no Lambda-backed autoDeleteObjects).
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'web/securityHeaders.ts plus HSTS (S-p5-5, AC-SEC-05)',
      ...responseHeadersFromMap(securityHeaders),
    })

    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      functionName: NAMES.spaFunction,
      code: cloudfront.FunctionCode.fromInline(SPA_FALLBACK_FUNCTION),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Client-side routes get index.html (as nginx try_files)',
    })

    const apiOrigin = new origins.HttpOrigin(alb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      customHeaders: { [ORIGIN_VERIFY_HEADER]: originSecret },
    })
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Cookies, the XSRF header and the `q` query string reach the API unchanged.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy: headers,
      compress: true,
    }

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'ascrum-migration demo (deleted by the run that created it)',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: Object.fromEntries(API_PATH_PATTERNS.map((pattern) => [pattern, apiBehavior])),
    })

    new CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` })
    new CfnOutput(this, 'LoadBalancerUrl', { value: `http://${alb.loadBalancerDnsName}` })
    new CfnOutput(this, 'WebBucketName', { value: bucket.bucketName })
    new CfnOutput(this, 'ApiLogGroup', { value: logGroup.logGroupName })
  }
}
