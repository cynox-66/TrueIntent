import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/postgres_data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    /**
     * The verification kernel must be a pure function of its context.
     *
     * A stage that reads the wall clock or a random source would make its
     * decision unreproducible, which would quietly break replay from evidence.
     * The determinism tests assert this behaviourally; this rule catches it at
     * review time, where it is cheaper to fix.
     */
    files: [
      'packages/kernel/src/stages/**/*.ts',
      'packages/kernel/src/kernel.ts',
      'packages/kernel/src/combine.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'The kernel must be pure: take the time from context.evaluatedAt.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'The kernel must be pure: use context.evaluatedAt.',
        },
        { object: 'Date', property: 'parse', message: 'Use millisBetween from @capturelock/core.' },
        { object: 'Math', property: 'random', message: 'The kernel must be deterministic.' },
        { object: 'crypto', property: 'randomUUID', message: 'The kernel must be deterministic.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'The kernel must be pure: take the time from context.evaluatedAt.',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
);
