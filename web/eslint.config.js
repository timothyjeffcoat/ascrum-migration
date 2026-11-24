// Lint gate. CLAUDE.md's "never weaken a gate" rules are enforced here mechanically where possible:
//   - inline `eslint-disable` comments are ignored and reported (noInlineConfig)
//   - @ts-ignore / @ts-expect-error / @ts-nocheck are errors; `any` is an error
//   - .only / .skip / .todo on tests are errors (Vitest allowOnly:false and Playwright forbidOnly back this up)
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const TEST_FNS = '/^(it|test|describe|suite)$/'
const WEAKENERS = '/^(only|skip|skipIf|runIf|todo|fixme)$/'
const GATE_MESSAGE =
  'Focused, skipped, conditional or placeholder tests weaken the gate (CLAUDE.md). Ask a question instead.'
const GATE_SELECTORS = [
  // it.skip, it.skipIf(c), test.fixme, describe.only, ...
  {
    selector: `MemberExpression[object.name=${TEST_FNS}][property.name=${WEAKENERS}]`,
    message: GATE_MESSAGE,
  },
  // it.concurrent.skip, test.describe.skip, test.describe.fixme, ...
  {
    selector: `MemberExpression[object.type='MemberExpression'][object.object.name=${TEST_FNS}][property.name=${WEAKENERS}]`,
    message: GATE_MESSAGE,
  },
]

/**
 * DEV-p5-containers-11: the API's run-time sources (api/src, web/stub) load modules with static imports
 * only. The API image holds exactly the files Node's loader resolves while importing main.ts
 * (docker/api/import-graph.ts), and an `import()` inside a function is never resolved there, so its
 * module would be left out of the image and fail only when that code path runs. The rule repeats the
 * gate selectors above, because a later `no-restricted-syntax` setting replaces an earlier one: these
 * files keep every check they had and gain this one. web/src is not covered (main.tsx loads MSW lazily
 * on purpose, and nothing in web/src goes into the API image). api/eslint.config.js applies the same
 * rule to api/src.
 */
export const SERVER_SOURCE_RULES = {
  'no-restricted-syntax': [
    'error',
    ...GATE_SELECTORS,
    {
      selector: 'ImportExpression',
      message:
        'No import() in the API sources (DEV-p5-containers-11): the API image only holds modules main.ts imports statically. Use a static import.',
    },
  ],
}

export default tseslint.config(
  { ignores: ['dist', 'dist-pages', 'coverage', 'playwright-report', 'test-results', 'public/mockServiceWorker.js'] },
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      'no-restricted-syntax': ['error', ...GATE_SELECTORS],
    },
  },
  { files: ['stub/**/*.ts'], rules: SERVER_SOURCE_RULES },
)
