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

function session({ prompt = () => systemPrompt, tools = [], settings = {} } = {}) {
  const handlers = new Map();
  const branch = [];
  let status;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => tools.map(tool => tool.name),
    getAllTools: () => tools,
    getSettings: () => settings,
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
  };
  const ctx = { getSystemPrompt: prompt, ui: { setStatus: (_key, value) => { status = value; } }, sessionManager: { getBranch: () => branch } };
  register(pi);
  return {
    branch,
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    say: text => branch.push({ type: 'message', message: { role: 'user', content: text, timestamp: branch.length + 1 } }),
    /** One model call: Pi builds the context, then sends the provider request. */
    turn: (payload = {}) => { handlers.get('context')({ messages: [] }, ctx); handlers.get('before_provider_request')({ payload }, ctx); },
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

test('the panel lists the tools the provider request declares, and marks the ones codemode scripts can call', () => {
  const tools = [
    { name: 'read', description: 'Read files', parameters: {}, exposure: 'direct' },
    { name: 'spawn_subagents', description: 'Start a child', parameters: {}, exposure: 'model-only' },
    { name: 'codemode', description: 'Run scripts', parameters: {}, exposure: 'direct' },
  ];
  const sent = names => ({ tools: names.map(name => ({ type: 'function', name, description: name === 'codemode' ? 'Run scripts\n\nNested tools:\n\n### read' : tools.find(tool => tool.name === name).description, parameters: {} })) });
  const panel = (mode, payload) => { const chat = session({ tools, settings: { codemode: { mode } } }); chat.say('hi'); chat.turn(payload); return chat.panel(); };
  const only = panel('only', sent(['spawn_subagents', 'codemode']));
  assert.deepEqual(only.tools.map(tool => [tool.name, tool.codemode]), [['spawn_subagents', false], ['codemode', undefined]]);
  assert.match(only.tools[1].description, /Nested tools:/, 'the codemode description as sent, with the declarations of the tools it calls');
  const on = panel('on', sent(['read', 'spawn_subagents', 'codemode']));
  assert.deepEqual(on.tools.map(tool => [tool.name, tool.codemode]), [['read', true], ['spawn_subagents', false], ['codemode', undefined]]);
});

test('request tools are read from Anthropic and Google request shapes too', () => {
  const read = (payload) => { const chat = session({ tools: [{ name: 'read', description: 'Read files', parameters: {} }] }); chat.say('hi'); chat.turn(payload); return chat.panel().tools; };
  assert.deepEqual(read({ tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }] }), [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]);
  assert.deepEqual(read({ config: { tools: [{ functionDeclarations: [{ name: 'read', description: 'Read', parametersJsonSchema: { type: 'object' } }] }] } }), [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]);
  assert.deepEqual(read({ tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }] }), [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]);
});

test('each user message saves one snapshot, and an unchanged prompt or tool list is not stored again', () => {
  const tools = [{ name: 'read', description: 'Read files', parameters: {} }];
  let prompt = systemPrompt;
  const chat = session({ tools, prompt: () => prompt });
  const saved = () => chat.branch.filter(entry => entry.customType === 'piop-context').map(entry => entry.data);
  chat.say('first');
  chat.turn();
  chat.turn();
  assert.equal(saved().length, 1, 'tool calls in one turn do not save again');
  assert.equal(saved()[0].systemPrompt, systemPrompt);
  chat.say('second');
  chat.turn();
  assert.deepEqual([saved()[1].systemPrompt, saved()[1].tools, saved()[1].sameAsPrevious], [undefined, undefined, { systemPrompt: true, tools: true }]);
  assert.equal(chat.panel().systemPrompt.startsWith('You are an expert coding assistant.'), true, 'the panel still gets the full prompt');
  prompt = systemPrompt.replace('Use tabs.', 'Use spaces.');
  chat.say('third');
  chat.turn();
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

test('a turn started by another agent session gets its own snapshot, linked by the delivery', () => {
  const chat = session();
  chat.say('hi');
  chat.turn();
  chat.branch.push({ type: 'custom_message', customType: 'piop-agent-message', content: 'Build is green', display: true, details: { notificationId: 'n1' } });
  chat.turn();
  const saved = chat.branch.filter(entry => entry.customType === 'piop-context').map(entry => entry.data);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].agentNotificationId, 'n1');
  assert.equal(saved[1].userTimestamp, undefined);
});

test('a turn started by a subagent result gets its own snapshot, linked by the delivery', () => {
  const chat = session();
  chat.say('hi');
  chat.turn();
  chat.branch.push({ type: 'custom_message', customType: 'piop-subagent-result', content: 'Subagent finished', display: true, details: { runs: [], notificationId: 'r1' } });
  chat.turn();
  const saved = chat.branch.filter(entry => entry.customType === 'piop-context').map(entry => entry.data);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].agentNotificationId, 'r1');
});
