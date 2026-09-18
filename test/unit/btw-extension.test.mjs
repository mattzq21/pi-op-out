import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/resources/btw.ts')) {
      if (specifier === 'node:os') return { url: 'data:text/javascript,export const homedir = () => "/isolated/home"', shortCircuit: true };
      if (specifier === 'node:child_process') return { url: 'data:text/javascript,export function execFile() { throw new Error("expected promise API"); } execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) => globalThis.__BTW_TEST_EXEC__(...args);', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return url.endsWith('/resources/btw.ts') ? { ...result, source: String(result.source).replaceAll('process.env', 'globalThis.__BTW_TEST_ENV__') } : result;
  },
});
const { default: btwExtension } = await import('../../src-tauri/resources/btw.ts'); hooks.deregister();

async function fixture(run) {
  const statuses = [], notices = [], messages = [], executions = [], inputs = [];
  let command, complete, session = '/session.jsonl', runtimeSettings;
  const done = new Promise(resolve => { complete = resolve; });
  globalThis.__BTW_TEST_ENV__ = {};
  globalThis.__BTW_TEST_EXEC__ = async (...args) => { executions.push(args); return { stdout: ' answer λ \n', stderr: '' }; };
  btwExtension({ registerCommand(name, value) { assert.equal(name, 'btw'); command = value; },
    events: { emit(name, probe) { assert.equal(name, 'piop:runtime-settings'); probe.settings = runtimeSettings; } },
    sendMessage(message, options) { messages.push({ message, options }); } });
  const ctx = { mode: 'rpc', cwd: '/project space', sessionManager: { getSessionFile: () => session, getLeafId: () => 'leaf' },
    ui: { notify(...args) { notices.push(args); }, async input(...args) { inputs.push(args); }, setStatus(key, value) { statuses.push([key, value]); if (value === undefined) complete(); } } };
  try { await run({ ctx, statuses, notices, messages, executions, inputs, done, execute: args => command.handler(args, ctx),
    setSession(value) { session = value; }, setSettings(value) { runtimeSettings = value; } }); }
  finally { delete globalThis.__BTW_TEST_ENV__; delete globalThis.__BTW_TEST_EXEC__; }
}

test('btw validates input and hands desktop side conversations to the UI without launching a child', async () => fixture(async f => {
  await f.execute(' \n '); assert.deepEqual(f.notices.pop(), ['/btw needs a message to send', 'warning']);
  f.setSession(undefined); await f.execute('question'); assert.deepEqual(f.notices.pop(), ['/btw needs a persisted session to branch from', 'error']);
  assert.deepEqual(f.statuses, []);
  f.setSession('/session.jsonl'); globalThis.__BTW_TEST_ENV__.PI_DESKTOP_BTW = '1';
  await f.execute(' question λ '); await f.done;
  assert.equal(f.inputs[0][0], '__pi_desktop_btw__');
  assert.deepEqual(JSON.parse(f.inputs[0][1]), { task: 'question λ', sessionFile: '/session.jsonl', leafId: 'leaf', cwd: '/project space' });
  assert.deepEqual(f.executions, []); assert.deepEqual(f.messages, []);
  assert.deepEqual(f.statuses, [['btw', 'Running side conversation…'], ['btw', undefined]]);
}));

test('btw fork launch preserves literal arguments, settings and extension configuration', async () => fixture(async f => {
  globalThis.__BTW_TEST_ENV__ = { PI_DESKTOP_PI_EXECUTABLE: "/bin/pi's executable", PI_DESKTOP_BTW: '1',
    PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION: '/search', PI_DESKTOP_DEFINED_AGENTS_EXTENSION: '/agents' };
  f.ctx.mode = 'tui'; f.setSettings({ model: 'example', flag: true });
  await f.execute(" literal $(command) question "); await f.done;
  const [executable, args, options] = f.executions[0]; assert.equal(executable, "/bin/pi's executable");
  assert.deepEqual(args.slice(0, 4), ['--print', '--approve', '--fork', '/session.jsonl']);
  assert.equal(args.at(-1), 'literal $(command) question');
  assert.equal(args[args.indexOf('--session-dir') + 1], '/isolated/home/.piop/sessions');
  assert.deepEqual(JSON.parse(args[args.indexOf('--piop-runtime-settings') + 1]), { model: 'example', flag: true });
  for (const path of ['/search', '/agents']) assert.ok(args.includes(path));
  assert.equal(options.cwd, '/project space'); assert.equal(options.env.PI_DESKTOP_BTW, '0'); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
  assert.deepEqual(f.messages, [{ message: { customType: 'pi-desktop-btw', content: 'Side conversation result:\n\nanswer λ', display: true, details: { task: 'literal $(command) question', parentLeafId: 'leaf' } }, options: { triggerTurn: false } }]);
  assert.deepEqual(f.notices, []);
}));

test('btw fallback uses the current Node launcher and reports empty output and subprocess diagnostics', async () => {
  for (const failure of [undefined, { stderr: ' stderr detail ', stdout: 'stdout', message: 'failed' }, { stdout: ' stdout detail ', message: 'failed' }, new Error('launch failed')]) {
    await fixture(async f => {
      globalThis.__BTW_TEST_EXEC__ = async (executable, args) => {
        assert.equal(executable, process.execPath); assert.equal(args[0], process.argv[1]);
        assert.equal(args.includes('--piop-runtime-settings'), false);
        if (failure) throw failure;
        return { stdout: ' \n' };
      };
      await f.execute('question'); await f.done;
      const detail = failure?.stderr?.trim() || failure?.stdout?.trim() || failure?.message || 'The /btw branch returned no output';
      assert.deepEqual(f.notices, [[`/btw failed: ${detail}`, 'error']]);
      assert.deepEqual(f.messages, []); assert.deepEqual(f.statuses.at(-1), ['btw', undefined]);
    });
  }
});
