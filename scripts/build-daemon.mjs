import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const debug = process.argv.includes('--debug');

if (!process.argv.includes('--skip-extensions')) run(process.execPath, ['scripts/build-extensions.mjs']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function hostTriple() {
  const result = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' });
  const triple = result.status === 0 ? result.stdout.match(/^host: (.+)$/m)?.[1] : undefined;
  if (triple) return triple;
  const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch] ?? process.arch;
  if (process.platform === 'linux') return arch + '-unknown-linux-gnu';
  if (process.platform === 'darwin') return arch + '-apple-darwin';
  if (process.platform === 'win32') return arch + '-pc-windows-msvc';
  throw new Error('Could not determine the native target');
}

/** Loads files imported with a "?raw" suffix as text. */
const rawText = {
  name: 'raw-text',
  setup(context) {
    context.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }));
    context.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text', watchFiles: [args.path] }));
  },
};

const extension = process.platform === 'win32' ? '.mjs' : '';
const source = join(root, 'target', debug ? 'debug' : 'release', 'piopd' + extension);
mkdirSync(dirname(source), { recursive: true });
const temporaryBuild = join(dirname(source), '.piopd-' + randomUUID() + '.mjs');

try {
  await build({
    entryPoints: [join(root, 'daemon/src/main.ts')],
    outfile: temporaryBuild,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    external: ['bun', 'bun:*'],
    banner: { js: "#!/usr/bin/env bun\nimport { createRequire as __piopCreateRequire } from 'node:module';\nconst require = __piopCreateRequire(import.meta.url);" },
    define: {
      __PIOP_DEVELOPMENT__: JSON.stringify(debug),
      __PIOP_PROJECT_DIR__: JSON.stringify(debug ? root.replace(/[\\/]+$/, '') : ''),
    },
    minify: !debug,
    keepNames: true,
    sourcemap: debug ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [rawText],
  });
  chmodSync(temporaryBuild, 0o755);
  if (!sameContent(temporaryBuild, source)) renameSync(temporaryBuild, source);
} finally {
  rmSync(temporaryBuild, { force: true });
}

function sameContent(left, right) {
  try { return readFileSync(left).equals(readFileSync(right)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const sourceStats = statSync(source);
let sourceContent;

function copyIfChanged(target) {
  try {
    const targetStats = statSync(target);
    if (targetStats.size === sourceStats.size && (process.platform === 'win32' || (targetStats.mode & 0o111) === (sourceStats.mode & 0o111))) {
      sourceContent ??= readFileSync(source);
      if (readFileSync(target).equals(sourceContent)) return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(target), '.piopd-' + randomUUID() + extension);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

if (!process.argv.includes('--skip-copy')) {
  mkdirSync(join(root, 'clients/desktop/binaries'), { recursive: true });
  copyIfChanged(join(root, 'clients/desktop/binaries', 'piopd-' + hostTriple() + extension));
}

if (process.argv.includes('--install')) {
  const binDirectory = join(homedir(), '.local', 'bin');
  const installed = join(binDirectory, 'piopd' + extension);
  mkdirSync(binDirectory, { recursive: true });
  console.log((copyIfChanged(installed) ? 'Installed' : 'Unchanged:') + ' ' + installed);
  if (!(process.env.PATH ?? '').split(delimiter).some(directory => resolve(directory) === binDirectory)) {
    console.warn('Add ' + binDirectory + ' to your PATH to run piopd directly.');
  }
}
