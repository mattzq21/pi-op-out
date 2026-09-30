import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let failed = false;

for (const script of ['lint:eslint', 'lint:oxlint']) {
  const result = spawnSync(npm, ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });

  if (result.error) console.error(result.error.message);

  if (result.status !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
