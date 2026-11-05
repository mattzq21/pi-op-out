import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { testPi } from '../pi-install.mjs';

const { root } = await testPi();
const sdk = name => import(pathToFileURL(join(root, `dist/core/${name}.js`)));
const { createAgentSession } = await sdk('sdk');
const { DefaultResourceLoader } = await sdk('resource-loader');
const { SettingsManager } = await sdk('settings-manager');
const { SessionManager } = await sdk('session-manager');
const { ModelRuntime } = await sdk('model-runtime');
process.env.PIOP_COMMAND_POLICY ??= JSON.stringify({ queued: [], disabled: {} });
const { dispatchPrompt, installQueueProtocol } = createRequire(import.meta.url)('../../daemon/resources/pi-runtime/bridge.ts');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('a direct prompt tags its user message with the client submission', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-direct-prompt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('openai', 'test-key-not-a-credential');
  const model = modelRuntime.getModels().find(model => model.provider === 'openai');
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(), tools: [] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  session.agent.streamFunction = model => {
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: 'done' }], usage, stopReason: 'stop' };
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, result: async () => message };
  };
  const outputs = [];
  installQueueProtocol(session, event => outputs.push(event));
  const settled = new Promise(resolve => session.subscribe(event => { if (event.type === 'agent_end') resolve(); }));
  dispatchPrompt({ type: 'prompt', command: 'prompt', id: 'request', message: 'Question', goalSubmissionId: 'submission' }, session, event => outputs.push(event));
  await settled;
  const user = session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user').message;
  assert.equal(user.piopSubmissionId, 'submission');
  assert.equal(user.piopQueueId, undefined);
  assert.ok(outputs.some(event => event.type === 'response' && event.id === 'request' && event.success));
});
