import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { testPi } from '../pi-install.mjs';

const { root } = await testPi();
const sdk = name => import(pathToFileURL(join(root, `dist/core/${name}.js`)));
const { createAgentSession } = await sdk('sdk');
const { DefaultResourceLoader } = await sdk('resource-loader');
const { SettingsManager } = await sdk('settings-manager');
const { SessionManager } = await sdk('session-manager');
const { ModelRuntime } = await sdk('model-runtime');

const SUMMARY = '## Goal\n- Keep working';
const usage = input => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.5 } });
const reply = (model, text, input, stopReason = 'stop') => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text }], usage: usage(input), stopReason, ...(stopReason === 'error' ? { errorMessage: 'provider down' } : {}) });
const readCall = (model, path) => ({ ...reply(model, '', 1000, 'toolUse'), content: [{ type: 'toolCall', id: `read-${path}`, name: 'read', arguments: { path } }] });
const readTool = { name: 'read', label: 'Read', description: 'Test read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: async () => ({ content: [{ type: 'text', text: 'file text' }], details: {} }) };
const stream = result => ({ async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result });

async function fixture(t, summaries) {
  const dir = await mkdtemp(join(tmpdir(), 'piop-background-compaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundled = await build({ entryPoints: ['plugins/background-compaction/extension/index.ts'], write: false, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', external: ['@earendil-works/*'] });
  const outfile = join(dir, 'plugin.mjs');
  await writeFile(outfile, bundled.outputFiles[0].text.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(pathToFileURL(join(root, 'dist/index.js')).href)));
  const { default: plugin } = await import(pathToFileURL(outfile));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1000 }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('openai', 'unused-test-key');
  const model = modelRuntime.getModels().find(model => model.provider === 'openai' && model.contextWindow >= 200_000);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [plugin] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(dir), tools: ['read'], customTools: [readTool] });
  t.after(() => session.dispose());
  const errors = [], notices = [], requests = [], summaryRequests = [];
  await session.bindExtensions({ onError: error => errors.push(error), uiContext: { setStatus() {}, notify: (...args) => notices.push(args) } });
  t.after(() => assert.deepEqual(errors, []));
  const sizes = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(context.messages);
    const next = sizes.shift();
    return stream(Promise.resolve(typeof next === 'string' ? readCall(model, next) : reply(model, 'done', next)));
  };
  modelRuntime.streamSimple = (model, context, options) => {
    summaryRequests.push({ messages: context.messages, options });
    return stream(Promise.resolve(summaries.shift()(model)));
  };
  const respond = async (text, ...replies) => { sizes.push(...replies); await session.prompt(text + ' ' + 'x'.repeat(8000)); };
  const compaction = () => session.sessionManager.getBranch().findLast(entry => entry.type === 'compaction');
  const threshold = model.contextWindow - 16384;
  return { session, model, notices, requests, summaryRequests, respond, compaction, early: Math.ceil(threshold * 0.9), due: threshold + 1000 };
}

test('a summary written in the background replaces the history it covers once compaction is due, and compaction waits for it', async t => {
  const written = Promise.withResolvers();
  const f = await fixture(t, [model => written.promise.then(() => reply(model, SUMMARY, 1000))]);
  await f.respond('first', 'src/a.ts', f.early);
  assert.equal(f.summaryRequests.length, 1);
  const [request] = f.summaryRequests;
  assert.deepEqual(request.messages.slice(0, -1), f.requests[1], 'the summary request repeats the request that the provider just cached');
  assert.match(request.messages.at(-1).content[0].text, /The messages above are a conversation to summarize\. Create a structured context checkpoint summary[\s\S]*## Constraints & Preferences/);
  assert.equal(request.options.sessionId, f.session.sessionManager.getSessionId());
  const firstResponse = f.session.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.equal(f.compaction(), undefined);

  f.session.subscribe(event => { if (event.type === 'compaction_start') written.resolve(); });
  await f.respond('second', f.due);
  assert.equal(f.summaryRequests.length, 1, 'Pi did not write a summary of its own');
  assert.deepEqual(f.compaction(), { ...f.compaction(), summary: `${SUMMARY}\n\n<read-files>\nsrc/a.ts\n</read-files>`, firstKeptEntryId: firstResponse.id, fromHook: true, details: { readFiles: ['src/a.ts'], modifiedFiles: [], source: 'piop-background-compaction' } });
  assert.equal(f.compaction().usage.cost.total, 0.5);
});

test('a failed background summary is reported, and Pi writes the summary when compaction is due', async t => {
  const f = await fixture(t, [model => reply(model, '', 0, 'error')]);
  await f.respond('first', f.early);
  await new Promise(setImmediate);
  assert.deepEqual(f.notices, [['Background compaction failed: provider down. Pi will write the summary when compaction is due.', 'warning']]);
  await f.respond('second', f.due);
  assert.equal(f.summaryRequests.length, 1);
  assert.equal(f.requests.length, 3, 'Pi sent its own summary request');
  assert.equal(f.compaction().fromHook, false);
});
