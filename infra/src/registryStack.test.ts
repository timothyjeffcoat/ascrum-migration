import { describe, it } from 'vitest'
import { synth } from './testApp.ts'

const { templates } = synth()

describe('registry stack', () => {
  it('spec §6 image-scan (Q-p5-7): the API repository scans every pushed image; tags are immutable', () => {
    templates.registry.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ascrum-demo-api',
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: 'IMMUTABLE',
    })
    templates.registry.resourceCountIs('AWS::ECR::Repository', 1)
  })
})
