import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fakeProgram, startDaemon, type TestDaemon } from './harness';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordTools } from '../../daemon/src/tool_inventory';

let daemon: TestDaemon;
let root: string;

beforeAll(async () => { daemon = await startDaemon(); root = join(daemon.home, '.agents/skills'); }, 60_000);
afterAll(() => daemon?.stop());

function write(path: string, content: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
const discovered = async () => (await daemon.invoke('load_app_settings', { refreshSkills: true })).skills;

test('a Codex policy file makes a skill user invoked only when policy.allow_implicit_invocation is false', async () => {
  const cases: Array<[string, boolean]> = [
    ['policy:\n  allow_implicit_invocation: false\n', true],
    ["# heading\npolicy:\n\n  # comment\n  allow_implicit_invocation: 'FALSE' # disabled\n", true],
    ['policy:\n  allow_implicit_invocation: "false"\n', true],
    ['policy:\n  allow_implicit_invocation: true\n', false],
    ['allow_implicit_invocation: false\n', false],
    ['policy:\n  other: false\ninterface:\n  allow_implicit_invocation: false\n', false],
    ['policy:\n  malformed line\n  other: false\n', false],
  ];
  write('no-policy/SKILL.md', 'Body');
  cases.forEach(([content], index) => { write('policy-' + index + '/SKILL.md', 'Body'); write('policy-' + index + '/agents/openai.yaml', content); });
  try {
    const skills = new Map((await discovered()).map((skill: any) => [skill.name, skill.userInvokedOnly]));
    expect(skills.get('no-policy')).toBe(false);
    cases.forEach(([content, expected], index) => expect(skills.get('policy-' + index), content).toBe(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill discovery reads metadata, skips hidden and package folders and stops at a parent skill', async () => {
  write('parent/SKILL.md', '---\nname: Named skill\ndescription: Useful description\ndisable-model-invocation: true\n---\nBody');
  for (const path of ['parent/nested', 'fallback', '.hidden', 'node_modules/package', 'codex']) write(path + '/SKILL.md', 'Body without metadata');
  write('codex/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n');
  write('notes.md', 'Plain skill');
  try {
    const skills = await discovered();
    expect(skills.map((skill: any) => skill.name).sort()).toEqual(['Named skill', 'codex', 'fallback']);
    const named = skills.find((skill: any) => skill.name === 'Named skill');
    expect(named).toMatchObject({ description: 'Useful description', userInvokedOnly: true, path: join(root, 'parent'), enabled: true });
    expect(skills.find((skill: any) => skill.name === 'fallback')).toMatchObject({ description: 'Pi skill', userInvokedOnly: false, enabled: true });
    expect(skills.find((skill: any) => skill.name === 'codex')).toMatchObject({ userInvokedOnly: true, enabled: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect(await discovered()).toEqual([]);
});

test('a started Pi receives the reported tools and only the enabled skills', async () => {
  // A fake Pi whose node side reads the startup records the way Pi's runtime settings, skills store and tool store extensions do.
  const bin = join(daemon.home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(path.join(process.env.HOME, 'runtime.json'), process.env.PIOP_AGENT_RESOURCES);
const args = process.argv.slice(2); const sessionFile = args[args.lastIndexOf('--session') + 1];
const state = { sessionFile, sessionId: JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').map(line => JSON.parse(line)) } : null }) + '\\n'); });
`);
  write('explicit/SKILL.md', '---\nname: Explicit\ndisable-model-invocation: true\n---\n');
  write('plain/SKILL.md', '---\nname: Plain\n---\n');
  write('off/SKILL.md', '---\nname: Off\n---\n');
  try {
    const settings = await daemon.invoke('load_app_settings', { refreshSkills: true });
    recordTools([{ name: 'read', description: 'Read files', source: 'builtin:read' }], join(daemon.home, '.piop/settings.json'));
    for (const skill of settings.skills) skill.enabled = skill.name !== 'Off';
    settings.contextWindowCap = 123456; settings.contextWindowCapEnabled = false;
    await daemon.invoke('save_app_settings', { settings });
    const saved = await daemon.invoke('load_app_settings');
    const { path } = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home: daemon.home, folder: 'runtime', content: '' }),
    }));
    await daemon.invoke('start_pi', { runtimeId: 'runtime-settings', clientId: 'test-client', cwd: daemon.home, sessionPath: path });
    const runtime = JSON.parse(readFileSync(join(daemon.home, 'runtime.json'), 'utf8'));
    expect(runtime.tools.registeredTools).toEqual(saved.tools.map((tool: any) => tool.name));
    expect(runtime.tools.enabledTools).toEqual(['read']);
    expect(runtime.skills).toEqual({ userInvokedSkills: [join(root, 'explicit')], agentInvokedSkills: [join(root, 'plain')] });
    // Building the runtime settings does not change the saved settings.
    expect(await daemon.invoke('load_app_settings')).toEqual(saved);
    await daemon.invoke('stop_pi', { runtimeId: 'runtime-settings' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
