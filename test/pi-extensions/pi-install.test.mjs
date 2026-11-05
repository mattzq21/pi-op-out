import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { installName, installPi } = require('../../daemon/resources/pi-install.cjs');
const { SUPPORTED_PI_VERSION } = require('../../daemon/resources/pi-runtime.cjs');

const manifest = '{"name":"piop-pi","dependencies":{"@earendil-works/pi-coding-agent":"' + SUPPORTED_PI_VERSION + '"}}';
const lockfile = '{"lockfileVersion":1}';

// A bun that installs a Pi of the given version and counts its runs, or fails.
function fakeBun(directory, { version = SUPPORTED_PI_VERSION, fail = false } = {}) {
  const bun = join(directory, 'bun');
  writeFileSync(bun, `#!/bin/sh
echo run >> ${JSON.stringify(join(directory, 'runs'))}
[ "$BUN_BE_BUN" = 1 ] && [ "$1" = install ] && [ -f bun.lock ] && [ -f package.json ] || { echo "bad call: $*" >&2; exit 3; }
${fail ? 'echo "registry unreachable" >&2; exit 1' : ''}
mkdir -p node_modules/@earendil-works/pi-coding-agent/dist/bundle "$BUN_INSTALL_CACHE_DIR"
printf '{"name":"@earendil-works/pi-coding-agent","version":"${version}","bin":{"pi":"dist/bundle/cli.js"}}' > node_modules/@earendil-works/pi-coding-agent/package.json
echo > node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
`);
  chmodSync(bun, 0o755);
  return { bun, runs: () => existsSync(join(directory, 'runs')) ? readFileSync(join(directory, 'runs'), 'utf8').trim().split('\n').length : 0 };
}

function fixture(options) {
  const home = mkdtempSync(join(tmpdir(), 'piop-pi-install-'));
  const { bun, runs } = fakeBun(home, options);
  const installs = join(home, '.piop', 'pi');
  const install = () => installPi({ home, manifest, lockfile, bun });
  return { home, bun, runs, installs, install, [Symbol.dispose]: () => rmSync(home, { recursive: true, force: true }) };
}

test('the first use installs Pi into its own folder, and later uses find it without installing again', async () => {
  using f = fixture();
  const pi = await f.install();
  const directory = join(f.installs, installName(manifest, lockfile));
  assert.equal(pi.cli, join(directory, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
  assert.deepEqual(readdirSync(f.installs), [installName(manifest, lockfile)]);
  assert.equal(existsSync(join(directory, '.cache')), false);
  assert.deepEqual(await f.install(), pi);
  assert.equal(f.runs(), 1);
});

test('uses that start during an install share it', async () => {
  using f = fixture();
  const [first, second] = await Promise.all([f.install(), f.install()]);
  assert.deepEqual(first, second);
  assert.deepEqual(readdirSync(f.installs), [installName(manifest, lockfile)]);
});

test('a failed install reports the output, leaves no folder, and the next use tries again', async () => {
  using f = fixture({ fail: true });
  await assert.rejects(f.install(), new RegExp(`^Error: Could not install Pi ${SUPPORTED_PI_VERSION.replaceAll('.', '\\.')} \\(exit code 1\\): registry unreachable$`));
  assert.deepEqual(readdirSync(f.installs), []);
  fakeBun(f.home);
  await f.install();
  assert.equal(f.runs(), 2);
});

test('an install that gives another Pi version is not used', async () => {
  using f = fixture({ version: '0.0.1' });
  await assert.rejects(f.install(), new RegExp(`^Error: Piop needs Pi ${SUPPORTED_PI_VERSION.replaceAll('.', '\\.')}, but found Pi 0\\.0\\.1 at `));
  assert.deepEqual(readdirSync(f.installs), []);
});

test('an install left by a stopped process is removed, and one of a running process is kept', async () => {
  using f = fixture();
  mkdirSync(f.installs, { recursive: true });
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const running = `.install-${process.pid}-${stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]}-00000000-0000-4000-8000-000000000001`;
  const stopped = `.install-${process.pid}-1-00000000-0000-4000-8000-000000000002`;
  mkdirSync(join(f.installs, running));
  mkdirSync(join(f.installs, stopped));
  await f.install();
  assert.deepEqual(readdirSync(f.installs).sort(), [running, installName(manifest, lockfile)].sort());
});
