// Entry point for the CDK CLI (cdk.json: `node bin/app.ts`, Node 24 type stripping). See src/app.ts.
import { App } from 'aws-cdk-lib'
import { buildStacks } from '../src/app.ts'

const app = new App()
buildStacks(app)
app.synth()
