import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

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
      "max-lines": ['error', { max: 750, skipComments: true }]
    },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
