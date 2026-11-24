// The ECR repository the API image goes to. Its own stack, deployed first: the workflow pushes the image
// built from this commit, waits for ECR's scan-on-push result and stops on any HIGH or CRITICAL finding
// (spec §6 image-scan, Q-p5-7) before the service that would run it exists.
//
// Destroyed with the rest (AC-AWS-04): emptyOnDelete is CloudFormation's own EmptyOnDelete, so the
// images go with the repository and no Lambda-backed custom resource is involved.
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import type { Construct } from 'constructs'
import { NAMES } from './names.ts'

export class RegistryStack extends Stack {
  readonly repository: ecr.Repository

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)
    this.repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: NAMES.apiRepository,
      imageScanOnPush: true,
      // One image per commit, never overwritten: the scan result belongs to exactly what runs.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    })
    new CfnOutput(this, 'ApiRepositoryUri', { value: this.repository.repositoryUri })
  }
}
