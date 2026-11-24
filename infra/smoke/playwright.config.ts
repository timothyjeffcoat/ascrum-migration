import { defineConfig, devices } from '@playwright/test'

// The post-deploy smoke test (AC-AWS-03), run by deploy-demo.yml against the freshly created `demo`:
//
//   SMOKE_BASE_URL=https://<distribution>.cloudfront.net SMOKE_ALB_URL=http://<alb dns> pnpm smoke
//
// Everything it writes goes to infra/evidence/, which the workflow keeps as an artifact (AC-AWS-07):
// the list output, a JSON report and the screenshot of the signed-in projects list.
const baseURL = process.env.SMOKE_BASE_URL
if (!baseURL?.startsWith('https://')) throw new Error('SMOKE_BASE_URL must be the https:// URL of the deployed demo')

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  outputDir: '../evidence/test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: '../evidence/smoke-results.json' }]],
  use: { ...devices['Desktop Chrome'], baseURL, trace: 'retain-on-failure' },
})
