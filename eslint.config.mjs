import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

/**
 * ONE flat config for the whole workspace (the packages share conventions,
 * so they share the linter — same reasoning as the shared env readers).
 *
 * Scope: the packages' TypeScript sources. UI (static browser JS),
 * loadtest, demo-data and shell scripts are build/ops surfaces with their
 * own rules of engagement — out of lint scope on purpose.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/ui/**',
      'loadtest/**',
      'demo-data/**',
      // scripts/*.mjs (spec-check, packaging-check, coverage-summary) are
      // CI gates — they get linted like everything else. The shell scripts
      // beside them are out of eslint's jurisdiction anyway.
      'clients/**',
      'deploy/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Last: silences every rule Prettier owns — formatting is Prettier's job,
  // the linter only judges semantics.
  prettierConfig,
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      // The logging invariant, enforced: production code speaks through the
      // injected Logger port (core/common/logging) — never console. The one
      // exception is below.
      'no-console': 'error',
      // Matches the codebase's `_req`-style discards.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // `const { dropped, ...rest } = doc` is the codebase's idiom for
          // omitting persistence-only fields.
          ignoreRestSiblings: true,
        },
      ],
      // The repo is strict-TS already; `any` only by explicit, visible choice.
      '@typescript-eslint/no-explicit-any': 'error',
      // null: ignore keeps the idiomatic `value != null` (null OR undefined).
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    // The runbook CLI surface (make sync, billing-close, price:insert…):
    // usage hints and ✖ messages are operator-facing terminal output, not
    // application logs — console IS the right sink here. Long-running
    // daemons that live in this directory still use the Logger by
    // convention (see run-billing-close-scheduler / run-trace-ingestion-loop).
    files: ['packages/*/src/main/jobs/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Jest configs and other .js/.mjs helpers — Node scripts, both module
    // systems, so the Node globals of each are declared here.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
