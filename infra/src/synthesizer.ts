// How the CDK CLI deploys these stacks (DEV-p5-infra-01). Neither stack goes through `cdk bootstrap`:
//
//   - no `cdk-*-deploy-role` is assumed: the CLI calls CloudFormation with the caller's own credentials
//     (the owner's for AscrumBootstrap, the GitHub deploy role's for the demo stacks), so what the caller
//     may do is exactly its own policy, scoped in bootstrapStack.ts to the `AscrumDemo*` stacks;
//   - the template goes inline (`TemplateBody`), not through a CDK staging bucket: these stacks have no
//     file or image assets (no Lambda, no Docker asset: the API image is pushed by the workflow), and
//     each template stays under CloudFormation's 51,200-byte inline limit (pinned by tests);
//   - for the demo stacks, the manifest names the CloudFormation execution role from the bootstrap stack
//     (`ascrum-cfn-exec`), which the CLI passes as `RoleARN`; the deploy role may create change sets with
//     that role only (`cloudformation:RoleArn` condition).
//
// CDK's own synthesizers cannot do this: DefaultStackSynthesizer and BootstraplessSynthesizer always name
// a deploy role to assume, and CliCredentialsStackSynthesizer always uploads the template to the CDK
// bootstrap bucket (which, for AscrumBootstrap, would have had to exist before it: see the worklog).
import {
  StackSynthesizer,
  type DockerImageAssetLocation,
  type FileAssetLocation,
  type ISynthesisSession,
} from 'aws-cdk-lib'

export type InlineTemplateSynthesizerProps = {
  /**
   * The role CloudFormation uses for this stack (`RoleARN`), with `${AWS::AccountId}`, `${AWS::Region}`
   * and `${AWS::Partition}` placeholders that the CLI fills in. Omitted: the caller's own credentials.
   */
  cloudFormationExecutionRoleArn?: string
}

export class InlineTemplateSynthesizer extends StackSynthesizer {
  private readonly executionRoleArn: string | undefined

  constructor(props: InlineTemplateSynthesizerProps = {}) {
    super()
    this.executionRoleArn = props.cloudFormationExecutionRoleArn
  }

  override get cloudFormationExecutionRole(): string | undefined {
    return this.executionRoleArn
  }

  addFileAsset(): FileAssetLocation {
    throw new Error('InlineTemplateSynthesizer: these stacks have no file assets (no Lambda, no bundled files)')
  }

  addDockerImageAsset(): DockerImageAssetLocation {
    throw new Error('InlineTemplateSynthesizer: the API image is pushed by the workflow, not as a CDK asset')
  }

  synthesize(session: ISynthesisSession): void {
    this.synthesizeTemplate(session)
    this.emitArtifact(session, { cloudFormationExecutionRoleArn: this.executionRoleArn })
  }
}
