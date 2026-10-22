import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (true) {
  const manifest = join(root, 'package.json');
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') break;
  const parent = dirname(root);
  if (parent === root) throw new Error('Could not locate the installed Pi SDK');
  root = parent;
}
const sdk = name => import(pathToFileURL(join(root, `dist/core/${name}.js`)));
const { createAgentSession } = await sdk('sdk');
const { AgentSession } = await sdk('agent-session');
const { installAvailability } = await import('../../daemon/resources/runtime-availability.cjs');
installAvailability(AgentSession);
const { DefaultResourceLoader } = await sdk('resource-loader');
const { SettingsManager } = await sdk('settings-manager');
const { SessionManager } = await sdk('session-manager');
const { ModelRuntime } = await sdk('model-runtime');
const usage = total => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total } });

let bundle;
function compiledCost() {
  return bundle ??= build({ stdin: { contents: 'export { default } from "./daemon/plugins/cost/index.ts"; export { default as hooksExtended } from "./daemon/resources/hooks-extended/index.ts";', resolveDir: process.cwd() }, write: false, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' }).then(result => result.outputFiles[0].contents);
}

async function fixture(t, { toolCost = 0, responseCost = 1, toolCalls = false, dir, sessionManager, extraExtensions = [], keepRecentTokens = 20000 } = {}) {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), 'piop-cost-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
  }
  const outfile = join(dir, 'cost.mjs');
  await writeFile(outfile, await compiledCost());
  const { default: costLimit, hooksExtended } = await import(pathToFileURL(outfile));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('openai', 'unused-test-key');
  const model = modelRuntime.getModels().find(model => model.provider === 'openai');
  assert.ok(model);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [hooksExtended, costLimit, ...extraExtensions] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  let executions = 0;
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model, settingsManager, resourceLoader, sessionManager: sessionManager?.(dir) ?? SessionManager.inMemory(dir), tools: ['cost_test'],
    customTools: [{ name: 'cost_test', label: 'Cost test', description: 'Test tool', parameters: { type: 'object', properties: {} }, execute: async () => {
      executions++;
      return { content: [{ type: 'text', text: 'done' }], details: {}, usage: usage(toolCost) };
    } }],
  });
  t.after(() => session.dispose());
  const statuses = new Map(), errors = [], notices = [];
  await session.bindExtensions({ onError: error => errors.push(error), uiContext: { setStatus: (key, value) => statuses.set(key, value), notify: (...args) => notices.push(args) } });
  let requests = 0, aborted = 0;
  session.agent.streamFunction = (model, _context, options) => {
    if (options.signal?.aborted) aborted++;
    else requests++;
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: toolCalls ? [{ type: 'toolCall', id: `call-${requests}`, name: 'cost_test', arguments: {} }] : [{ type: 'text', text: 'done' }],
      usage: usage(options.signal?.aborted ? 0 : responseCost), stopReason: options.signal?.aborted ? 'aborted' : toolCalls ? 'toolUse' : 'stop',
    };
    assert.ok(requests < 4, 'cost limit must stop the agent loop');
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
  };
  t.after(() => assert.deepEqual(errors, []));
  return { session, statuses, notices, model, get requests() { return requests; }, get executions() { return executions; }, get aborted() { return aborted; } };
}

test('a reopened saved session keeps its reached limit and refuses new prompts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-cost-test-'));
  const first = await fixture(t, { dir, sessionManager: cwd => SessionManager.create(cwd, join(cwd, 'sessions')) });
  await first.session.prompt('/cost 1');
  await first.session.prompt('spend the limit');
  const path = first.session.sessionManager.getSessionFile();
  assert.ok(path && existsSync(path));
  first.session.dispose();
  const reopened = await fixture(t, { dir, sessionManager: cwd => SessionManager.open(path, join(cwd, 'sessions')) });
  // After hooks run in registration order; remove the shared directory after both sessions are disposed.
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(reopened.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
  await reopened.session.prompt('after reopening');
  assert.equal(reopened.requests, 0);
  assert.equal(JSON.parse(reopened.statuses.get('piop-input-rejected')).text, 'after reopening');
});

test('an invalid cost value is reported and the prior limit still applies after reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-cost-test-'));
  const first = await fixture(t, { dir, sessionManager: cwd => SessionManager.create(cwd, join(cwd, 'sessions')) });
  await first.session.prompt('/cost 1');
  await first.session.prompt('/cost 0');
  assert.deepEqual(first.notices.at(-1), ['Invalid amount "0". Usage: /cost <amount in USD> or /cost clear (between $0.01 and $100,000)', 'error']);
  await first.session.prompt('spend the limit');
  assert.equal(first.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
  const path = first.session.sessionManager.getSessionFile();
  first.session.dispose();
  const reopened = await fixture(t, { dir, sessionManager: cwd => SessionManager.open(path, join(cwd, 'sessions')) });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await reopened.session.prompt('after reopening');
  assert.equal(reopened.requests, 0);
  assert.equal(JSON.parse(reopened.statuses.get('piop-input-rejected')).text, 'after reopening');
});

test('a cleared limit stays cleared after reopening the saved session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-cost-test-'));
  const first = await fixture(t, { dir, sessionManager: cwd => SessionManager.create(cwd, join(cwd, 'sessions')) });
  await first.session.prompt('/cost 1');
  await first.session.prompt('spend the limit');
  await first.session.prompt('/cost clear');
  const path = first.session.sessionManager.getSessionFile();
  first.session.dispose();
  const reopened = await fixture(t, { dir, sessionManager: cwd => SessionManager.open(path, join(cwd, 'sessions')) });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(reopened.statuses.get('piop-session-cost'), undefined);
  await reopened.session.prompt('after reopening');
  assert.equal(reopened.requests, 1);
});

test('real session blocks prompts at the limit and accepts raise and clear commands', async t => {
  const f = await fixture(t);
  await f.session.prompt('/cost 1');
  await f.session.prompt('first');
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
  await f.session.prompt('blocked');
  assert.equal(f.requests, 1);
  assert.equal(JSON.parse(f.statuses.get('piop-input-rejected')).text, 'blocked');
  await f.session.prompt('/cost 2');
  await f.session.prompt('second');
  assert.equal(f.requests, 2);
  await f.session.prompt('/cost clear');
  await f.session.prompt('third');
  assert.equal(f.requests, 3);
  assert.equal(f.statuses.get('piop-session-cost'), undefined);
});

test('navigating the session tree back before a lowered limit restores the earlier limit', async t => {
  const f = await fixture(t);
  await f.session.prompt('/cost 2');
  await f.session.prompt('spend one dollar');
  const response = f.session.sessionManager.getLeafId();
  await f.session.prompt('/cost 1');
  await f.session.prompt('blocked at lowered limit');
  assert.equal(f.requests, 1);
  const result = await f.session.navigateTree(response);
  assert.equal(result.cancelled, false);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session $1.00 / $2.00');
  await f.session.prompt('allowed on earlier branch');
  assert.equal(f.requests, 2);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($2.00 / $2.00)');
});

test('real session blocks tools when the response reaches the limit', async t => {
  const f = await fixture(t, { toolCalls: true });
  await f.session.prompt('/cost 1');
  await f.session.prompt('run tool');
  assert.equal(f.requests, 1);
  assert.equal(f.executions, 0);
  assert.ok(f.session.messages.some(message => message.role === 'toolResult' && message.isError));
});

test('real session stops the next request when a tool charge reaches the limit', async t => {
  const f = await fixture(t, { toolCalls: true, responseCost: 0.75, toolCost: 0.25 });
  await f.session.prompt('/cost 1');
  await f.session.prompt('run tool');
  assert.equal(f.executions, 1);
  assert.equal(f.requests, 1);
  assert.equal(f.aborted, 1);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
});

for (const kind of ['compaction', 'cache_warm']) test(`${kind} charges added during request preparation stop that request`, async t => {
  const f = await fixture(t);
  await f.session.prompt('/cost 1');
  const prepare = f.session.agent.prepareRequest;
  f.session.agent.prepareRequest = async (...args) => {
    const prepared = await prepare(...args);
    // Model routing can compact after turn_start, before the request context is built.
    const manager = f.session.sessionManager;
    if (kind === 'compaction') manager.appendCompaction('Summary', manager.getLeafId(), 100, undefined, false, usage(1));
    else manager.appendUsage(kind, f.model.provider, f.model.id, usage(1));
    return prepared;
  };
  await f.session.prompt('must not spend after preparation');
  assert.equal(f.requests, 0);
  assert.equal(f.aborted, 1);
});


for (const operation of ['tree success', 'tree cancelled', 'compact cancelled', 'compact failed', 'compact success']) {
  test(`session_available follows real ${operation} after Pi clears its busy state`, async t => {
    let notifications = 0;
    let operationStarted = false;
    let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const f = await fixture(t, { responseCost: 0, keepRecentTokens: 1, extraExtensions: [pi => {
      const request = {};
      pi.events.emit('hooks-extended', request);
      request.hooks.on('session_available', (_event, ctx) => {
        if (operationStarted) { notifications++; assert.equal(ctx.isIdle(), true); ready(); }
      });
      pi.on('session_before_tree', () => operation === 'tree cancelled' ? { cancel: true } : undefined);
      pi.on('session_before_compact', event => {
        if (operation === 'compact cancelled') return { cancel: true };
        return { compaction: { summary: 'Summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      });
    }] });
    await f.session.prompt('first');
    const target = f.session.sessionManager.getLeafId();
    await f.session.prompt('second');
    await f.session.waitForIdle();
    // Finish the notification for the preceding run before starting the history operation.
    await new Promise(resolve => setImmediate(resolve));
    operationStarted = true;
    if (operation.startsWith('tree')) {
      const result = await f.session.navigateTree(target);
      assert.equal(result.cancelled, operation === 'tree cancelled');
    } else {
      if (operation === 'compact cancelled') await assert.rejects(f.session.compact(), /cancelled/i);
      else if (operation === 'compact failed') {
        // A missing model fails before session_before_compact is reached.
        const currentModel = f.session.agent.state.model;
        f.session.agent.state.model = undefined;
        await assert.rejects(f.session.compact());
        f.session.agent.state.model = currentModel;
      } else await f.session.compact();
    }
    await available;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications, 1);
  });
}
