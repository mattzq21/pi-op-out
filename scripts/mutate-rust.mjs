import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const available = spawnSync('cargo', ['mutants', '--version'], { encoding: 'utf8' });
if (available.error || available.status !== 0) {
  console.error('Install Rust mutation testing with: cargo install --locked cargo-mutants');
  process.exit(1);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'piop-rust-mutants-'));
try {
  for (const directory of ['src-tauri', 'extensions', 'dist']) {
    await cp(join(root, directory), join(temporaryRoot, directory), {
      recursive: true,
      filter: source => !['target', 'node_modules', '.git', 'mutants.out', 'mutants.out.old'].includes(basename(source)),
    });
  }
  const result = spawnSync('cargo', [
    'mutants',
    '--in-place',
    '--output', join(root, 'reports', 'mutation', 'rust'),
    ...process.argv.slice(2),
  ], {
    cwd: join(temporaryRoot, 'src-tauri'),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
