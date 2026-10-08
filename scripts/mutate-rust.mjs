import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  for (const directory of ['Cargo.toml', 'Cargo.lock', 'daemon', 'crates/protocol', 'clients/desktop', 'clients/ui', 'extensions', 'dist']) {
    await cp(join(root, directory), join(temporaryRoot, directory), {
      recursive: true,
      filter: source => !['target', 'node_modules', '.git', 'mutants.out', 'mutants.out.old'].includes(basename(source)),
    });
  }

  const manifest = join(temporaryRoot, 'daemon', 'Cargo.toml');
  const manifestSource = await readFile(manifest, 'utf8');

  if (!manifestSource.includes('[lib]\n')) throw new Error('Rust mutation runner requires a library target');
  const backend = join(temporaryRoot, 'daemon', 'src', 'backend.rs');
  const library = await readFile(join(temporaryRoot, 'daemon', 'src', 'lib.rs'), 'utf8');
  const backendInclude = 'include!("backend.rs");';

  if (!library.includes(backendInclude)) throw new Error('Rust mutation runner requires the backend library include');
  await writeFile(backend, library.slice(0, library.indexOf(backendInclude)) + await readFile(backend, 'utf8'));
  await writeFile(manifest, manifestSource.replace('[lib]\n', '[lib]\npath = "src/backend.rs"\n'));
  const tauriConfig = JSON.parse(process.env.TAURI_CONFIG || '{}');
  tauriConfig.bundle = { ...tauriConfig.bundle, externalBin: [] };

  const result = spawnSync('cargo', [
    'mutants',
    '--in-place',
    '--exclude', '**/*tests.rs',
    '--output', join(root, 'reports', 'mutation', 'rust'),
    ...process.argv.slice(2),
  ], {
    cwd: join(temporaryRoot, 'daemon'),
    env: {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(root, 'target'),
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '1',
      RUST_MIN_STACK: process.env.RUST_MIN_STACK || '16777216',
      RUST_TEST_THREADS: process.env.RUST_TEST_THREADS || '1',
      TAURI_CONFIG: JSON.stringify(tauriConfig),
    },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
