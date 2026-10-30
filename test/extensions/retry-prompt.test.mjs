import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(root, 'package.json')) || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== '@earendil-works/pi-coding-agent') {
  const parent = dirname(root);
  if (parent === root) throw new Error('Could not locate the installed Pi SDK');
  root = parent;
}
const sdk = name => import(pathToFileURL(join(root, `dist/core/${name}.js`)));
const { createAgentSession } = await sdk('sdk');
const { DefaultResourceLoader } = await sdk('resource-loader');
const { SettingsManager } = await sdk('settings-manager');
const { SessionManager } = await sdk('session-manager');
const { ModelRuntime } = await sdk('model-runtime');
process.env.PIOP_COMMAND_POLICY ??= JSON.stringify({ queued: [], disabled: {} });
const { continueRun } = createRequire(import.meta.url)('../../daemon/resources/runtime-bridge.cjs');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('a retried response keeps the prompt that extensions set for the run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-retry-prompt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('openai', 'test-key-not-a-credential');
  const model = modelRuntime.getModels().find(model => model.provider === 'openai');
  const agentPrompt = pi => pi.on('before_agent_start', event => { event.systemPromptOptions.customPrompt = 'AGENT PROMPT'; });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [agentPrompt] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(), tools: ['read'] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  // Tool call, failure; after the retry: tool call, answer. The tool call after the retry makes Pi rebuild the prompt for the next request.
  const replies = [['toolUse'], ['error'], ['toolUse'], ['stop']];
  session.agent.streamFunction = model => {
    const [stopReason] = replies.shift();
    const content = stopReason === 'toolUse' ? [{ type: 'toolCall', id: `call-${replies.length}`, name: 'read', arguments: { path: directory } }] : stopReason === 'stop' ? [{ type: 'text', text: 'done' }] : [];
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, usage, stopReason, ...(stopReason === 'error' ? { errorMessage: 'failed' } : {}) };
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: stopReason, message }; }, result: async () => message };
  };
  await session.prompt('Question');
  const failed = session._findLastAssistantMessage();
  assert.equal(failed.stopReason, 'error');
  session._isAgentRunActive = true;
  session._agentRunAbortRequested = false;
  session._omitRecoveryAttempt(failed);
  session._recordSelection();
  await continueRun(session, failed);
  assert.equal(replies.length, 0);
  const prompts = session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'system').map(entry => entry.message.sections?.preamble);
  assert.deepEqual(prompts, ['AGENT PROMPT']);
});
