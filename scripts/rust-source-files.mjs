import { execFileSync } from 'node:child_process';

export function rustSourceFiles(options) {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.rs',
    ':(exclude)**/target/**',
  ], options);

  return [...new Set(output.split('\0').filter(Boolean))];
}
