import tsParser from '@typescript-eslint/parser';

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
      'extensions/piop-codex-compaction/upstream/**',
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
  },
];
