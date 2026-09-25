import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const unusedOptions = { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true };

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-mobile/**',
      'android/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/resources/*.bundle.mjs',
      '.stryker-tmp/**',
      'reports/**',
      '**/mutants.out/**',
      '**/mutants.out.old/**',
      'vite.config.js',
      'vite.config.d.ts',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      complexity: ['error', { max: 10, variant: 'classic' }],
      "max-lines": ['error', { max: 750, skipComments: true }],
      'no-unused-vars': ['error', unusedOptions],
      'no-unreachable': 'error',
      'no-unused-labels': 'error',
    },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedOptions],
    },
  },
];
