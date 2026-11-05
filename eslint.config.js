// ESLint flat config.
//
// Why this exists, written the day it was added (2026-11-05): the project had
// no linter at all, and that is how a removal left <ProfileModal>,
// <DisputeModal> and <PaymentModal> rendered after their imports were deleted.
// Vite builds fine — esbuild does not resolve identifiers — so the first thing
// that noticed was 33 failing E2E tests against a blank screen. `no-undef`
// alone would have stopped that at edit time, and `no-unused-vars` is what had
// let dozens of dead declarations accumulate unseen.
//
// Deliberately narrow. This is a gate against the two failures that actually
// cost time here, not a style regime: formatting, import order and stylistic
// preferences are left alone so that a lint run means something is broken
// rather than something is unfashionable.

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...js.configs.recommended.rules,
      // The two that earn their keep. An unused name is reported as an error
      // rather than a warning because the removal work in progress produces
      // them by the dozen and a warning would scroll past.
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        // A caught error that is deliberately ignored is idiomatic here —
        // several catch blocks exist only to keep a failure non-fatal.
        caughtErrors: 'none',
        // Leading underscore is the escape hatch for a genuinely unused
        // destructured value or argument.
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // Real, but a different kind of real: these are pre-existing design
      // observations about effects and memoisation, not the shape errors this
      // config exists to stop. Kept visible as warnings so the error count
      // keeps meaning "something is broken".
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.recommended.rules).map(r => [r, 'warn'])
      ),
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
    },
  },

  // Test files: vitest and Playwright globals, and a test may legitimately
  // declare a fixture it does not use in every case.
  {
    files: ['tests/**/*.{js,jsx}', '**/*.test.{js,jsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
]
