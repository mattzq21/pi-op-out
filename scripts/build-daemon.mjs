import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  return arch + '-unknown-linux-gnu';
}

/** Loads files imported with a "?raw" suffix as text. */
const rawText = {
  name: 'raw-text',
  setup(context) {
    context.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }));
    context.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text', watchFiles: [args.path] }));
  },
};

/** Resolves the agent definition loader of the piop-define-agents extension and the settings module it shares with the daemon. */
const agentLoader = {
  name: 'agent-loader',
  setup(context) {
    context.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(root, 'extensions/piop-define-agents/daemon-loader.ts') }));
    context.onResolve({ filter: /^\.\.\/app-settings\.cjs$/ }, args => args.importer.includes('/extensions/piop-define-agents/') ? { path: join(root, 'daemon/resources/session-broker/app-settings.cjs') } : undefined);
  },
};

const source = join(root, 'target', debug ? 'debug' : 'release', 'piopd');
mkdirSync(dirname(source), { recursive: true });
const temporaryBuild = join(dirname(source), '.piopd-' + randomUUID() + '.mjs');
const temporaryExecutable = join(dirname(source), '.piopd-' + randomUUID());
// The placeholder has the same length as the final ID, so the inline source map stays correct.
const buildIdPlaceholder = 'piop-build-' + randomBytes(32).toString('hex');

try {
  await build({
    entryPoints: [join(root, 'daemon/src/main.ts')],
    outfile: temporaryBuild,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    external: ['bun', 'bun:*', 'x11', 'usocket'], // dbus-next loads these optional modules only for bus addresses Piop does not use.
    banner: { js: "#!/usr/bin/env bun\nimport { createRequire as __piopCreateRequire } from 'node:module';\nconst require = __piopCreateRequire(import.meta.url);\nif (process.argv[2] === '--build-id') { process.stdout.write(" + JSON.stringify(buildIdPlaceholder) + " + '\\n'); process.exit(0); }" },
    define: {
      __PIOP_BUILD_ID__: JSON.stringify(buildIdPlaceholder),
      __PIOP_DEVELOPMENT__: JSON.stringify(debug),
      __PIOP_PROJECT_DIR__: JSON.stringify(debug ? root.replace(/[\\/]+$/, '') : ''),
    },
    minify: !debug,
    keepNames: true,
    sourcemap: debug ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [rawText, agentLoader],
  });
  const bundle = readFileSync(temporaryBuild, 'utf8');
  if (!bundle.includes(buildIdPlaceholder)) throw new Error('Daemon build ID is missing from the bundle');
  const buildId = 'piop-build-' + createHash('sha256').update(bundle.replaceAll(buildIdPlaceholder, '')).digest('hex');
  if (buildId.length !== buildIdPlaceholder.length) throw new Error('Daemon build ID length changed');
  writeFileSync(temporaryBuild, bundle.replaceAll(buildIdPlaceholder, buildId));
  // Agent definition loads import the installed Pi package in a worker thread. Without package.json reads, imports of its dependencies fail.
  if (!debug) run(process.execPath, ['build', '--compile', '--compile-autoload-package-json', temporaryBuild, '--outfile', temporaryExecutable]);
  const output = debug ? temporaryBuild : temporaryExecutable;
  chmodSync(output, 0o755);
  if (!sameContent(output, source)) renameSync(output, source);
} finally {
  rmSync(temporaryBuild, { force: true });
  rmSync(temporaryExecutable, { force: true });
}

function sameContent(left, right) {
  try { return readFileSync(left).equals(readFileSync(right)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const sourceStats = statSync(source);
let sourceContent;

function copyIfChanged(target) {
  try {
    const targetStats = statSync(target);
    if (targetStats.size === sourceStats.size && (targetStats.mode & 0o111) === (sourceStats.mode & 0o111)) {
      sourceContent ??= readFileSync(source);
      if (readFileSync(target).equals(sourceContent)) return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(target), '.piopd-' + randomUUID());
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
  copyIfChanged(join(root, 'clients/desktop/binaries', 'piopd-' + hostTriple()));
}

if (process.argv.includes('--install')) {
  const binDirectory = join(homedir(), '.local', 'bin');
  const installed = join(binDirectory, 'piopd');
  mkdirSync(binDirectory, { recursive: true });
  console.log((copyIfChanged(installed) ? 'Installed' : 'Unchanged:') + ' ' + installed);
  if (!(process.env.PATH ?? '').split(delimiter).some(directory => resolve(directory) === binDirectory)) {
    console.warn('Add ' + binDirectory + ' to your PATH to run piopd directly.');
  }
}
