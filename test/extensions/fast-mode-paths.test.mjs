import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform, build } from 'esbuild';

test('manual fast mode survives agent restoration in either handler order', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-fast-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const compiled = await build({ entryPoints: ['extensions/piop-openai-fast-mode/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(dir, 'index.mjs')).href) }, plugins: [{ name: 'agent-dir', setup(builder) {
    builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getAgentDir = () => "/unused";' }));
  } }] });

  const { createPiFastModeExtension } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

  for (const enabled of [true, false]) for (const agentFirst of [true, false]) {
    const entries = [], statuses = new Map();
    const ctx = { cwd: dir, hasUI: true, mode: 'rpc', model: { provider: 'openai', id: 'gpt-5.4' }, sessionManager: { getSessionId: () => 'id', getBranch: () => entries }, ui: { setStatus: (key, value) => statuses.set(key, value), notify: message => assert.fail(message) } };

    const load = () => {
      const handlers = new Map(), commands = new Map(); let agent;
      createPiFastModeExtension({ extensionDir: dir, agentDir: dir })({ on: (name, fn) => handlers.set(name, fn), events: { emit: (name, value) => { if (name === 'piop:fast-mode-changed') entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { fastModeOverride: value.enabled } }); }, on: (_name, fn) => { agent = fn; } }, registerFlag() {}, getFlag: () => false, registerCommand: (name, fn) => commands.set(name, fn), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });

      return { start: () => handlers.get('session_start')({}, ctx), agent: restore => agent({ apply: true, enabled: restore ? entries.at(-1)?.data.fastModeOverride : !enabled, restore, ctx }), toggle: () => commands.get('fast').handler(enabled ? 'on' : 'off', ctx) };
    };

    let extension = load(); await extension.start(); extension.agent(false); await extension.toggle();
    extension = load();

    if (agentFirst) extension.agent(true);
    await extension.start();

    if (!agentFirst) extension.agent(true);
    assert.equal(statuses.get('pi-desktop-fast-mode'), enabled ? 'Fast mode on' : 'Fast mode off');
  }
});

test('renamed fast-mode config preserves legacy user and project settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-fast-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const name of ['config', 'types']) {
    const source = (await readFile(new URL(`../../extensions/piop-openai-fast-mode/src/${name}.ts`, import.meta.url), 'utf8'))
      .replace('import { getAgentDir } from "@earendil-works/pi-coding-agent";', 'const getAgentDir = () => "/unused";')
      .replace('"./types"', '"./types.mjs"');

    await writeFile(join(dir, `${name}.mjs`), (await transform(source, { loader: 'ts', format: 'esm' })).code);
  }

  const { loadConfigForScope, getUserConfigPath, getProjectConfigPath } = await import(pathToFileURL(join(dir, 'config.mjs')));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'project');
  const legacyUser = join(agentDir, 'extensions', 'pi-openai-fast-mode-piop', 'config.json');
  await mkdir(join(legacyUser, '..'), { recursive: true });
  await writeFile(legacyUser, JSON.stringify({ enabled: true }));
  const user = await loadConfigForScope({ cwd, agentDir });
  assert.equal(user.path, getUserConfigPath(agentDir));
  assert.match(user.path, /piop-openai-fast-mode/);
  assert.equal(user.config.enabled, true);
  await writeFile(getUserConfigPath(agentDir), JSON.stringify({ enabled: false }));
  assert.equal((await loadConfigForScope({ cwd, agentDir })).config.enabled, false);
  const legacyProject = join(cwd, '.pi', 'pi-openai-fast-mode-piop', 'config.json');
  await mkdir(join(legacyProject, '..'), { recursive: true });
  await writeFile(legacyProject, JSON.stringify({ enabled: true }));
  const project = await loadConfigForScope({ cwd, agentDir });
  assert.equal(project.scope, 'project');
  assert.equal(project.path, getProjectConfigPath(cwd));
  assert.equal(project.config.enabled, true);
});
