// infra/ is linted by exactly web's rules (web/eslint.config.js holds the gate: no inline disables, no
// `any`, no @ts-* comments, no focused or skipped tests). ESLint 10 looks for a config next to each file,
// so this folder needs its own entry point. It adds only the CDK output folders to the ignores.
import webConfig from '../web/eslint.config.js'

export default [{ ignores: ['cdk.out', 'test-results', 'evidence'] }, ...webConfig]
