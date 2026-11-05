import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('every skill called at the start of a prompt reaches the model, and an unknown one stops the prompt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-multiple-skills-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skill = async name => {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} body\n`);
    return join(directory, name, 'SKILL.md');
  };
  const [alpha, beta] = [await skill('alpha'), await skill('beta')];
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('openai', 'test-key-not-a-credential');
  const model = modelRuntime.getModels().find(model => model.provider === 'openai');
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    additionalSkillPaths: [alpha, beta], additionalExtensionPaths: [resolve('daemon/resources/skills/extension.ts')] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(), tools: [] });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ uiContext: { notify: (message, type) => { if (type === 'error') errors.push(message); }, setStatus() {} } });
  session.agent.streamFunction = model => {
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: 'done' }], usage, stopReason: 'stop' };
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, result: async () => message };
  };
  const sent = () => session.messages.filter(message => message.role === 'user').map(message => message.content.map(part => part.text).join(''));
  const block = (name, path) => `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${name} body\n</skill>`;

  await session.prompt('/skill:alpha /skill:beta $alpha then $beta');
  await session.prompt('/skill:beta only beta');
  await session.prompt('/skill:alpha /skill:missing $alpha with $missing');
  assert.deepEqual(sent(), [`${block('alpha', alpha)}\n\n${block('beta', beta)}\n\n$alpha then $beta`, `${block('beta', beta)}\n\nonly beta`]);
  assert.deepEqual(errors, ['Skill "missing" is not available']);
});
