import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { fileURLToPath } from 'node:url';

const typescript = ['**/*.ts', '**/*.tsx'];
const nodeGlobals = Object.fromEntries(
  [
    'AbortController',
    'AbortSignal',
    'Buffer',
    'Request',
    'URL',
    'URLSearchParams',
    '__dirname',
    '__filename',
    'clearInterval',
    'clearTimeout',
    'console',
    'exports',
    'fetch',
    'global',
    'module',
    'performance',
    'process',
    'require',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone',
  ].map((name) => [name, 'readonly'])
);

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.worktrees/**',
      '.claude/**',
      // Generated data has its own deterministic contract checks.
      'src/generated/**',
    ],
  },
  {
    ...js.configs.recommended,
    languageOptions: { globals: nodeGlobals },
  },
  ...tsPlugin.configs['flat/recommended'].map((config) => ({
    ...config,
    files: typescript,
  })),
  {
    files: typescript,
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    // Jest intentionally consumes returned promises and async callbacks. Keep
    // the first type-aware rollout on shipped code; all files get recommended
    // correctness rules above. Lint probes protect these promise rules.
    ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
];
