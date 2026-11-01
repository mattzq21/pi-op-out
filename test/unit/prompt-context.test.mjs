import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { PromptContextBar } from '../../clients/ui/components/PromptContextBar.tsx';
import { clearMocks } from '@tauri-apps/api/mocks';

let dom, view;
beforeEach(() => { dom = installDom(); clearMocks(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

const context = () => ({
  tokens: { system: 1, instructions: 1, tools: 1, skills: 0 },
  systemPrompt: 'System content',
  instructions: [{ path: '/AGENTS.md', content: 'Instructions content' }],
  tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
  skills: [{ name: 'skill', description: 'Skill description', filePath: '/SKILL.md' }],
});

const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.startsWith(label));

test('equal context shares display whole percentages that total 100', async () => {
  view = await renderComponent(PromptContextBar, { context: context(), inputTokens: 3 });
  assert.deepEqual(['System', 'Instructions', 'Tools', 'Skills'].map(label => button(label).textContent), [
    'System 34%', 'Instructions 33%', 'Tools 33%', 'Skills 0%',
  ]);
});

for (const [label, content] of [
  ['System', 'System content'],
  ['Instructions', '/AGENTS.md'],
  ['Tools', 'Read file'],
  ['Skills', '/SKILL.md'],
]) test(`${label} can show and hide its source details`, async () => {
  view = await renderComponent(PromptContextBar, { context: context(), inputTokens: 3 });
  const control = button(label);
  assert.equal(control.getAttribute('aria-expanded'), 'false');
  assert.ok(!document.body.textContent.includes(content));
  await act(() => control.click());
  assert.equal(control.getAttribute('aria-expanded'), 'true');
  assert.ok(document.body.textContent.includes(content));
  await act(() => control.click());
  assert.equal(control.getAttribute('aria-expanded'), 'false');
  assert.ok(!document.body.textContent.includes(content));
});

const emptyContext = () => ({ tokens: { system: 0, instructions: 0, tools: 0, skills: 0 }, systemPrompt: '', instructions: [], tools: [], skills: [] });

test('context shares clear when context becomes empty', async () => {
  view = await renderComponent(PromptContextBar, { context: context(), inputTokens: 3 });
  await view.rerender({ context: emptyContext(), inputTokens: 0 });
  assert.deepEqual(['System', 'Instructions', 'Tools', 'Skills'].map(label => button(label).textContent), [
    'System 0%', 'Instructions 0%', 'Tools 0%', 'Skills 0%',
  ]);
});

for (const [label, explanation] of [
  ['System', 'No system prompt'],
  ['Instructions', 'No project instructions'],
  ['Tools', 'No active tools'],
  ['Skills', 'No defined skills'],
]) test(`${label} explains an empty context`, async () => {
  view = await renderComponent(PromptContextBar, { context: context(), inputTokens: 3 });
  await view.rerender({ context: emptyContext(), inputTokens: 0 });
  await act(() => button(label).click());
  assert.ok(document.body.textContent.includes(explanation));
});

test('empty skills display zero shares for defined, invoked and shared instructions', async () => {
  view = await renderComponent(PromptContextBar, { context: emptyContext(), inputTokens: 0 });
  await act(() => button('Skills').click());
  assert.deepEqual(['Defined', 'Invoked', 'Tax'].map(label => button(label).textContent), [
    'Defined 0%', 'Invoked 0%', 'Tax 0%',
  ]);
});

test('each tool, instruction and skill has its own copy button, and a tool copies its JSON too', async () => {
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { copied.push(text); } }, configurable: true });
  const input = context();
  input.tools.push({ name: 'write', description: 'Write file', parameters: { type: 'object', properties: { path: { type: 'string' } } } });
  view = await renderComponent(PromptContextBar, { context: input, inputTokens: 3 });
  const copy = async label => {
    const node = document.querySelector('[aria-label="' + label + '"]');
    assert.ok(node, label);
    await act(() => node.click());
  };
  await act(() => button('Tools').click());
  assert.equal(document.querySelector('[aria-label="Copy tab content"]'), null);
  await copy('Copy read');
  await copy('Copy write');
  await act(() => button('Instructions').click());
  await copy('Copy /AGENTS.md');
  await act(() => button('Skills').click());
  await copy('Copy skill');
  assert.deepEqual(copied, [
    'read\nRead file\n{\n  "type": "object"\n}',
    'write\nWrite file\n{\n  "type": "object",\n  "properties": {\n    "path": {\n      "type": "string"\n    }\n  }\n}',
    '/AGENTS.md\nInstructions content',
    'skill\nSkill description\n/SKILL.md',
  ]);
});
