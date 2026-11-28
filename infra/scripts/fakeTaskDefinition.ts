// Test fixtures: the demo's service and task definition as AWS answers for them once the deploy is up, for
// taskDefinition.test.ts (an in-process fake) and entrypoints.test.ts (fakeAwsBin.ts). The container carries
// an environment value, a secret ARN and a command, which the evidence record must never keep.
export const ACCOUNT = '123456789012'
export const REGION = 'eu-west-1'
export const TAG = 'f42e1765d32ea1aa4f05fc15a4a9ac08bf6f83f6'
export const SERVICE_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/ascrum-demo/AscrumDemo-ApiService-abc`
export const TASK_DEFINITION_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/ascrum-demo-api:7`

/** AWS's copy as DescribeTaskDefinition returns it, with the fields the record must never keep. */
export function liveContainer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'api',
    image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/ascrum-demo-api:${TAG}`,
    user: '1000:1000',
    readonlyRootFilesystem: true,
    linuxParameters: { capabilities: { add: [], drop: ['ALL'] }, devices: [], initProcessEnabled: true, tmpfs: [] },
    environment: [{ name: 'DB_HOST', value: 'environment-value-never-kept' }],
    secrets: [
      { name: 'DB_PASSWORD', valueFrom: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds-db-xyz:password::` },
    ],
    command: ['start-script-never-kept'],
    ...overrides,
  }
}

export const liveAnswers = (container = liveContainer(), service: Record<string, unknown> = {}) => ({
  resources: {
    StackResourceSummaries: [
      { ResourceType: 'AWS::ECS::Cluster', PhysicalResourceId: 'ascrum-demo' },
      { ResourceType: 'AWS::ECS::Service', PhysicalResourceId: SERVICE_ARN },
    ],
  },
  services: {
    services: [
      {
        serviceArn: SERVICE_ARN,
        status: 'ACTIVE',
        runningCount: 1,
        desiredCount: 1,
        taskDefinition: TASK_DEFINITION_ARN,
        deployments: [
          { status: 'PRIMARY', taskDefinition: TASK_DEFINITION_ARN, runningCount: 1, rolloutState: 'COMPLETED' },
        ],
        ...service,
      },
    ],
    failures: [],
  },
  taskDefinition: {
    taskDefinition: {
      taskDefinitionArn: TASK_DEFINITION_ARN,
      family: 'ascrum-demo-api',
      revision: 7,
      status: 'ACTIVE',
      containerDefinitions: [container],
    },
  },
})
