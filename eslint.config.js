import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/resources/*.bundle.mjs',
      'extensions/pi-codex-compaction/upstream/**',
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
    },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: { parser: tsParser },
  },
];
