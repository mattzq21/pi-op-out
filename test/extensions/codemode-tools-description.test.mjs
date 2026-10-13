import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-codemode-description-'));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, 'extension.mjs');
await build({ entryPoints: ['extensions/piop-codemode-tools-description/index.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { default: register } = await import(pathToFileURL(outfile));
const entry = data => ({ type: 'custom', customType: 'piop-codemode-abilities', data });
const tool = (name, description, exposure) => ({ name, description, exposure });

function fixture({ tools = [], active = ['codemode'], branch = [] } = {}) {
  const handlers = new Map();
  const f = { tools, active, branch: structuredClone(branch), prompt: '' };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => f.active,
    getAllTools: () => f.tools,
    appendEntry: (name, data) => { assert.equal(name, 'piop-codemode-abilities'); f.branch.push(entry(structuredClone(data))); },
  };
  const ctx = { sessionManager: { getBranch: () => f.branch }, getSystemPrompt: () => f.prompt };
  register(pi);
  f.emit = (name, event = {}) => handlers.get(name)(event, ctx);
  f.start = (options = {}) => { f.emit('before_agent_start', { systemPromptOptions: options }); return options; };
  return f;
}

test('descriptions follow tool exposure, summarize once, and retain tool guidelines', () => {
  const f = fixture({ active: ['codemode', 'read', 'active_direct'], tools: [
    { ...tool('codemode', 'Run code'), promptGuidelines: ['Use JavaScript', 'Await tools'] },
    tool('read', '  Read   files. More details.'), tool('active_direct', 'Read files! More', 'direct'),
    tool('inactive_direct', 'Hidden direct', 'direct'), tool('inactive_default', 'Hidden default'),
    tool('deferred', 'Search documents\nMore details', 'deferred'), tool('code_only', 'Draw diagrams?', 'codemode'),
    tool('empty_description', '' , 'codemode'), tool('hidden', 'Hidden', 'hidden'),
    tool('long', 'word '.repeat(40), 'deferred'),
  ] });
  const options = f.start({ sections: { unrelated: 'Keep' }, toolGuidelines: { read: ['Keep read'] } });
  assert.match(options.sections.codemode, /^Use JavaScript\nAwait tools\n\nCodemode's tools abilities include: Read files; Search documents; Draw diagrams; empty description; /);
  assert.ok(options.sections.codemode.endsWith('...'));
  assert.equal(options.sections.unrelated, 'Keep');
  assert.deepEqual(options.toolGuidelines, { read: ['Keep read'], codemode: [] });
  assert.deepEqual(f.branch[0].data.tools, ['read', 'active_direct', 'deferred', 'code_only', 'empty_description', 'long']);
  f.start();
  assert.equal(f.branch.length, 1);
});

test('disabled Codemode changes neither prompts nor saved history', () => {
  const f = fixture({ active: [], tools: [tool('search', 'Search', 'deferred')] });
  assert.deepEqual(f.start({ forceSystemPrompt: 'Fixed' }), { forceSystemPrompt: 'Fixed' });
  assert.equal(f.emit('context_with_system', { messages: [] }), undefined);
  assert.equal(f.emit('before_provider_request', { payload: { system: 'Fixed' } }), undefined);
  assert.deepEqual(f.branch, []);
});

test('an empty tool set is recorded once, then new tools form a later batch', () => {
  const f = fixture();
  assert.equal(f.start().sections.codemode, "Codemode's tools abilities include: no tools currently available");
  f.start();
  assert.equal(f.branch.length, 1);
  f.tools.push(tool('search', 'Search files', 'deferred'));
  assert.equal(f.start().sections.codemode_abilities_1, "Codemode's tools abilities also include: Search files");
  assert.equal(f.branch.length, 2);
});

test('saved branch history survives reload and inserts later batches at their saved times once', () => {
  const saved = { tools: ['old', 'new'], batches: [{ text: 'Original abilities', timestamp: 10 }, { text: 'Later abilities', timestamp: 30 }] };
  const f = fixture({ branch: [entry({ tools: [], batches: [] }), entry(saved)], tools: [tool('new', 'Changed description', 'deferred')] });
  const options = f.start({ sections: { codemode: 'Custom instructions' } });
  assert.equal(options.sections.codemode, 'Custom instructions\n\nOriginal abilities');
  assert.equal(options.sections.codemode_abilities_1, 'Later abilities');
  assert.deepEqual(f.branch[1].data, saved);
  assert.equal(f.branch.length, 2);
  const messages = [{ role: 'user', content: 'Before', timestamp: 20 }, { role: 'assistant', content: [], timestamp: 40 }];
  const result = f.emit('context_with_system', { messages });
  assert.deepEqual(result.messages.map(message => message.timestamp), [20, 30, 40]);
  assert.equal(result.messages[1].sections.codemode_abilities_1, '<codemode_abilities_1>\nLater abilities\n</codemode_abilities_1>');
  assert.equal(messages.length, 2);
  assert.deepEqual(f.emit('context_with_system', result), result);
  f.branch = [entry({ tools: ['old'], batches: [saved.batches[0]] })];
  f.tools = [];
  assert.equal(f.start().sections.codemode_abilities_1, undefined);
});

test('invalid saved entries start a fresh description batch', () => {
  const f = fixture({ branch: [entry({ tools: 'bad', batches: [] })] });
  assert.match(f.start().sections.codemode, /no tools currently available/);
  assert.equal(f.branch.length, 2);
});

test('a later prompt override retains saved batches and receives tools added during a turn', () => {
  const f = fixture({ branch: [entry({ tools: ['old', 'new'], batches: [
    { text: 'Original abilities', timestamp: 10 }, { text: 'Later abilities', timestamp: 30 },
  ] })] });
  assert.equal(f.start({ forceSystemPrompt: 'Fixed' }).forceSystemPrompt, 'Fixed\n\nOriginal abilities\n\nLater abilities');
  const options = f.start();
  options.forceSystemPrompt = 'Skill-filtered prompt\n\nOriginal abilities\n\nLater abilities';
  f.prompt = options.forceSystemPrompt;
  f.tools.push(tool('draw', 'Draw diagrams', 'codemode'));
  const result = f.emit('context_with_system', { messages: [] });
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[1].sections.codemode_abilities_2, /Draw diagrams/);
  const payload = f.emit('before_provider_request', { payload: { instructions: f.prompt } });
  assert.equal(payload.instructions, f.prompt + "\n\nCodemode's tools abilities also include: Draw diagrams");
  assert.equal(f.branch.length, 2);
});

test('forced prompts receive new abilities across provider formats without changing user content', () => {
  const f = fixture({ tools: [{ ...tool('codemode', 'Run code'), promptGuidelines: ['Use code'] }] });
  const options = f.start({ forceSystemPrompt: 'Fixed', sections: { unrelated: 'Keep separate' } });
  assert.equal(options.forceSystemPrompt, "Fixed\n\nUse code\n\nCodemode's tools abilities include: no tools currently available");
  f.prompt = options.forceSystemPrompt;
  f.tools.push(tool('search', 'Search files', 'deferred'));
  const prompt = f.prompt;
  const replacement = prompt + "\n\nCodemode's tools abilities also include: Search files";
  const payload = {
    instructions: prompt, system: [{ text: prompt }], systemInstruction: { parts: [{ text: prompt }] },
    config: { temperature: 1, systemInstruction: { parts: [{ text: prompt }] } },
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: prompt }],
    input: [{ role: 'developer', content: [{ type: 'input_text', text: prompt }] }, { role: 'assistant', content: prompt }],
    other: prompt,
  };
  const result = f.emit('before_provider_request', { payload });
  assert.equal(result.instructions, replacement);
  assert.equal(result.system[0].text, replacement);
  assert.equal(result.systemInstruction.parts[0].text, replacement);
  assert.equal(result.config.systemInstruction.parts[0].text, replacement);
  assert.equal(result.config.temperature, 1);
  assert.equal(result.messages[0].content, replacement);
  assert.equal(result.input[0].content[0].text, replacement);
  assert.equal(result.messages[1].content, prompt);
  assert.equal(result.input[1].content, prompt);
  assert.equal(result.other, prompt);
  assert.equal(payload.instructions, prompt);
  f.prompt = replacement;
  assert.equal(f.emit('before_provider_request', { payload: result }), undefined);
  f.start();
  f.tools.push(tool('edit', 'Edit files', 'deferred'));
  assert.equal(f.emit('before_provider_request', { payload }), undefined);
});
