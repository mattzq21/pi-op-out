import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-rtk-'));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, 'extension.mjs');
await build({ entryPoints: ['extensions/piop-rtk/rtk.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { default: register } = await import(pathToFileURL(outfile));

/** A session with a fake rtk program: version answers --version, rewrite maps a command to rtk's reply. */
async function session({ version = { code: 0, stdout: 'rtk 0.23.1\n' }, rewrite = () => ({ code: 1, stdout: '' }) } = {}) {
  const handlers = new Map();
  const statuses = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    exec: async (program, args) => {
      assert.equal(program, 'rtk');
      return { killed: false, stderr: '', ...(args[0] === '--version' ? version : rewrite(args[1])) };
    },
  };
  const ctx = { ui: { setStatus: (key, value) => statuses.set(key, value) } };
  register(pi);
  await handlers.get('session_start')({}, ctx);
  const run = async (toolName, command) => {
    const event = { toolName, input: { command } };
    await handlers.get('tool_call')(event, ctx);
    return event.input.command;
  };
  return { run, statuses };
}

test('shell commands go through rtk when it has a shorter form, and pass through otherwise', async () => {
  const replies = { 'git status': { code: 0, stdout: 'rtk git status\n' }, 'cargo test': { code: 3, stdout: 'rtk cargo test' }, 'ls': { code: 1, stdout: '' } };
  const { run, statuses } = await session({ rewrite: command => replies[command] ?? { code: 0, stdout: '' } });
  assert.equal(statuses.get('rtk'), undefined);
  assert.equal(await run('bash', 'git status'), 'rtk git status');
  assert.equal(await run('bash', 'cargo test'), 'rtk cargo test');
  assert.equal(await run('bash', 'ls'), 'ls');
  assert.equal(await run('bash', 'echo hi'), 'echo hi');
  assert.equal(await run('bash', 'rtk git log'), 'rtk git log');
  assert.equal(await run('other', 'git status'), 'git status');
});

test('a missing or too old rtk turns rewriting off and says why', async () => {
  const cases = [
    [{ code: 127, stdout: '' }, 'RTK disabled: rtk version check failed; check that rtk is in PATH'],
    [{ code: 0, stdout: 'rtk 0.22.9' }, 'RTK disabled: rtk 0.22.9 is too old (need >= 0.23.0)'],
    [{ code: 0, stdout: 'rtk dev build' }, 'RTK disabled: Could not read the rtk version'],
  ];
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [version, status] of cases) {
      const { run, statuses } = await session({ version, rewrite: () => ({ code: 0, stdout: 'rtk git status' }) });
      assert.equal(statuses.get('rtk'), status);
      assert.equal(await run('bash', 'git status'), 'git status');
    }
  } finally { console.warn = warn; }
  const { statuses } = await session({ version: { code: 0, stdout: 'rtk 1.0.0' } });
  assert.equal(statuses.get('rtk'), undefined, 'a newer major version is supported');
});
