// Lint gate. CLAUDE.md's "never weaken a gate" rules are enforced here mechanically where possible:
//   - inline `eslint-disable` comments are ignored and reported (noInlineConfig)
//   - @ts-ignore / @ts-expect-error / @ts-nocheck are errors; `any` is an error
//   - .only / .skip / .todo on tests are errors (Vitest allowOnly:false and Playwright forbidOnly back this up)
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

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
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(it|test|describe)$/][callee.property.name=/^(only|skip|todo|fixme)$/]",
          message: 'Focused, skipped or placeholder tests weaken the gate (CLAUDE.md). Ask a question instead.',
        },
      ],
    },
  },
)
