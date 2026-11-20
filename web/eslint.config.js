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
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
)
