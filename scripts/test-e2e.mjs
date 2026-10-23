import { copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const { values } = parseArgs({ options: { grep: { type: 'string' }, list: { type: 'boolean' }, build: { type: 'boolean' } } });

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });

  if (result.error) throw result.error;

  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.signal ?? result.status}`);
}

/** Builds the release app with the test-only bridge entry (test/e2e/bridge/main.ts) into target/e2e. */
async function buildE2E() {
  run('bun', ['scripts/build-daemon.mjs', '--skip-extensions', '--skip-copy']);
  const { build } = await import('vite');
  const frontend = resolve('target/e2e/dist');
  await build({ root: process.cwd(), configFile: resolve('vite.config.ts'), mode: 'production', build: { outDir: frontend, emptyOutDir: true },
    resolve: { alias: [{ find: /^@tauri-apps\/api\/core$/, replacement: resolve('test/e2e/bridge/tauri-core.ts') }] },
    plugins: [{ name: 'e2e-bridge',
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'e2e-cleanup.html', source: '<!doctype html><title>Piop fixture cleanup</title><body data-piop-fixture-cleanup></body>' }); },
      transformIndexHtml: { order: 'pre', handler: html => { if (!html.includes('/clients/ui/main.tsx')) throw new Error('index.html no longer loads clients/ui/main.tsx'); return html.replace('/clients/ui/main.tsx', '/test/e2e/bridge/main.ts'); } } }] });
  const tauriConfig = { bundle: { externalBin: [] }, build: { devUrl: null, beforeBuildCommand: null, frontendDist: frontend },
    app: { windows: [{ title: 'piop', width: 1440, height: 900, minWidth: 900, minHeight: 640, focus: false, decorations: false, transparent: false, backgroundColor: '#181817', dragDropEnabled: true }] } };
  run('cargo', ['build', '--locked', '--release', '-p', 'piop-desktop', '--bin', 'piop'], { ...process.env, CARGO_TARGET_DIR: resolve('target/e2e'), TAURI_CONFIG: JSON.stringify(tauriConfig) });
  mkdirSync('target/e2e/release', { recursive: true });
  // A rename replaces the daemon even while an old test app still runs it.
  copyFileSync('target/release/piopd', 'target/e2e/release/piopd.new');
  renameSync('target/e2e/release/piopd.new', 'target/e2e/release/piopd');
}

if (values.build) await buildE2E();

const file = 'test/e2e/specs/conversation.acceptance.spec.ts';

const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);

const titles = [];

function collect(node, parents = []) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
    const name = node.expression.text;
    const title = [...parents, node.arguments[0].text];

    if (name === 'it') { titles.push(title.join(' '));

    return; }

    if (name === 'describe') { collect(node.arguments[1], title);

    return; }
  }

  ts.forEachChild(node, child => collect(child, parents));
}

for (const statement of source.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.endsWith('.cases.js')) continue;
  const casesFile = resolve(dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
  collect(ts.createSourceFile(casesFile, readFileSync(casesFile, 'utf8'), ts.ScriptTarget.Latest));
}

collect(source);

const selected = values.grep ? titles.filter(title => new RegExp(values.grep).test(title)) : titles;

if (!selected.length) throw new Error('No E2E tests matched');

if (values.list) {
  console.log(selected.join('\n'));
} else {
  let failed = false;
  const batchSize = 10;

  for (let start = 0; start < selected.length; start += batchSize) {
    const batch = selected.slice(start, start + batchSize);
    const pattern = `^(?:${batch.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
    console.log(`E2E batch ${Math.floor(start / batchSize) + 1}: tests ${start + 1}–${start + batch.length} of ${selected.length}`);
    const child = spawn(process.execPath, ['--max-old-space-size=1536', 'node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.ts', '--mochaOpts.grep', pattern], { stdio: 'inherit' });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });

    if (result.signal) throw new Error(`E2E runner terminated by ${result.signal}`);

    if (result.code !== 0) failed = true;
  }

  process.exitCode = failed ? 1 : 0;
}
