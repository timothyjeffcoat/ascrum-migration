// Test helper: a YAML parser and serialiser without adding a dependency. aws-cdk-lib ships `yaml` (1.x)
// as a bundled dependency; its package exports do not expose it, so it is loaded from aws-cdk-lib's own
// folder. Used to read the workflow files (workflows.test.ts) and to measure a template the way the CDK
// CLI sends it to CloudFormation (YAML, inline below 50 KiB).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

type Yaml = {
  parse: (text: string) => unknown
  stringify: (value: unknown, options?: { schema?: string }) => string
}

const require = createRequire(import.meta.url)
const yaml = require(join(dirname(require.resolve('aws-cdk-lib/package.json')), 'node_modules', 'yaml')) as Yaml

export const parseYaml = (text: string): unknown => yaml.parse(text)

/** The template as YAML 1.1, as the CDK CLI serialises it for `TemplateBody`. */
export const templateYaml = (template: unknown): string => yaml.stringify(template, { schema: 'yaml-1.1' })
