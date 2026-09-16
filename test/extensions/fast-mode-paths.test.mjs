import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

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
