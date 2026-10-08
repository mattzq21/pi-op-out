import { spawn } from 'node:child_process';
import { GitDiffFilter } from '../../../clients/ui/lib/diffPolicy';

const [base, current] = process.argv.slice(1);

if (!/^[a-f\d]{40,64}$/i.test(base ?? '') || !/^[a-f\d]{40,64}$/i.test(current ?? '')) throw new Error('Invalid Git diff trees');

const filter = new GitDiffFilter();

const child = spawn('git', ['diff', '--no-relative', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', base, current, '--']);

let stderr = '';

child.stdout.setEncoding('utf8');

child.stdout.on('data', (chunk: string) => filter.write(chunk));

child.stderr.setEncoding('utf8');

child.stderr.on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length); });

child.on('error', error => { console.error(error.message); process.exitCode = 1; });

child.on('close', code => {
  if (code !== 0) {
    console.error(stderr.trim() || 'Could not capture Git diff'); process.exitCode = 1;

    return;
  }

  try { process.stdout.write(filter.finish()); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
});
