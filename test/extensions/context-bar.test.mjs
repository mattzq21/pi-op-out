import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-context-bar-'));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = async (entry, name) => {
  const outfile = join(dir, name);
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(pathToFileURL(outfile));
};
const { default: register } = await bundle('extensions/piop-context-bar/index.ts', 'extension.mjs');
const { separatePromptInstructions } = await bundle('clients/ui/lib/promptInstructions.ts', 'panel.mjs');

const project = join(homedir(), 'code/app');
/** The end of a system prompt as Pi 1.1.0 renders it (core/system-prompt.js buildSystemPrompt). */
const systemPrompt = `You are an expert coding assistant.

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="${project}/AGENTS.md">
Use tabs.
</project_instructions>
</project_context>

<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test &amp; design first</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
</available_skills>
</skills>

<cwd>
${project}
</cwd>`;

function session({ prompt = () => systemPrompt, tools = [] } = {}) {
  const handlers = new Map();
  const branch = [];
  let status;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => tools.map(tool => tool.name),
    getAllTools: () => tools,
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
  };
  const ctx = { getSystemPrompt: prompt, ui: { setStatus: (_key, value) => { status = value; } }, sessionManager: { getBranch: () => branch } };
  register(pi);
  return {
    branch,
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    say: text => branch.push({ type: 'message', message: { role: 'user', content: text, timestamp: branch.length + 1 } }),
    panel: () => separatePromptInstructions(JSON.parse(status.slice('json:'.length))),
  };
}

test('the context panel lists project instructions, the working directory and skills from Pi\'s prompt', () => {
  const chat = session();
  chat.say('hi');
  chat.emit('context', { messages: [] });
  const panel = chat.panel();
  assert.deepEqual(panel.instructions, [{ path: '~/code/app/AGENTS.md', content: 'Use tabs.' }, { path: 'Working directory', content: project }]);
  assert.deepEqual(panel.skills, [{ name: 'tdd', description: 'Test & design first', filePath: '/skills/tdd/SKILL.md' }]);
  assert.ok(!panel.systemPrompt.includes('<cwd>'));
  assert.ok(panel.tokens.instructions > 0 && panel.tokens.skills > 0 && panel.tokens.system > 0);
});

test('each user message saves one snapshot, and an unchanged prompt or tool list is not stored again', () => {
  const tools = [{ name: 'read', description: 'Read files', parameters: {} }];
  let prompt = systemPrompt;
  const chat = session({ tools, prompt: () => prompt });
  const saved = () => chat.branch.filter(entry => entry.customType === 'piop-context').map(entry => entry.data);
  chat.say('first');
  chat.emit('context', { messages: [] });
  chat.emit('context', { messages: [] });
  assert.equal(saved().length, 1, 'tool calls in one turn do not save again');
  assert.equal(saved()[0].systemPrompt, systemPrompt);
  chat.say('second');
  chat.emit('context', { messages: [] });
  assert.deepEqual([saved()[1].systemPrompt, saved()[1].tools, saved()[1].sameAsPrevious], [undefined, undefined, { systemPrompt: true, tools: true }]);
  assert.equal(chat.panel().systemPrompt.startsWith('You are an expert coding assistant.'), true, 'the panel still gets the full prompt');
  prompt = systemPrompt.replace('Use tabs.', 'Use spaces.');
  chat.say('third');
  chat.emit('context', { messages: [] });
  assert.equal(saved()[2].systemPrompt, prompt);
  assert.deepEqual(saved()[2].sameAsPrevious, { tools: true });
});

test('the real input token count from OpenAI is shown for the turn that used it', () => {
  const chat = session();
  const usage = tokens => ({ api: 'openai-codex-responses', data: { response: { usage: { input_tokens: tokens } } } });
  chat.say('hi');
  chat.emit('context', { messages: [] });
  chat.emit('provider_stream_event', { api: 'anthropic-messages', data: { response: { usage: { input_tokens: 5 } } } });
  assert.equal(chat.panel().inputTokens, undefined);
  chat.emit('provider_stream_event', usage(1234));
  assert.equal(chat.panel().inputTokens, 1234);
  chat.emit('provider_stream_event', usage(99));
  assert.equal(chat.panel().inputTokens, 1234, 'later requests in the same turn do not replace it');
});
