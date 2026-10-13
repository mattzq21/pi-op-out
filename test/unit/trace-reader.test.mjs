import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, basename, relative } from 'node:path';
import { publishedTrace } from '../trace-command-fixture.mjs';

// The pi SDK is not installed in this workspace; the trace tool only needs its schema builder.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/resources/trace-reader.ts') && specifier === '@earendil-works/pi-ai') return { url: 'data:text/javascript,export const Type = { Object: properties => ({properties}), String: options => ({type:"string",...options}), Integer: options => ({type:"integer",...options}), Optional: schema => schema }', shortCircuit: true };

    return nextResolve(specifier, context);
  },
});

const { default: traceReader } = await import('../../daemon/resources/trace-reader.ts');

hooks.deregister();

const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, message: { role, content, ...extra } });

/** Complete JSONL records: every record ends with a newline, as the daemon writes them. */
const lines = entries => entries.map(entry => `${JSON.stringify(entry)}\n`).join('');

const conversation = lines([message('user', null, 'user', 'Question'), message('answer', 'user', 'assistant', 'Answer')]);

test('trace cleaning follows the active branch and removes synthetic and intermediate messages', async t => {
  const entries = [
    message('u', null, 'user', ' Original '), message('old', 'u', 'assistant', 'abandoned branch'),
    message('skill', 'u', 'user', '<skill name="x">instructions</skill>'),
    message('config', 'skill', 'user', '/pi-define-agents-config config'),
    { type: 'custom', id: 'resume', parentId: 'config', customType: 'pi-desktop-resume', data: { message: 'resume text' } },
    message('resumed', 'resume', 'user', 'resume text'),
    message('tool', 'resumed', 'assistant', 'working', { stopReason: 'toolUse' }),
    message('result', 'tool', 'toolResult', 'private output'),
    message('answer', 'result', 'assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Final ' }, null, { type: 'image' }, { type: 'text', text: 'answer' }]),
  ];

  const trace = await publishedTrace(t, traceReader, lines(entries));
  assert.equal((await trace.read()).content[0].text, 'USER\nOriginal\n\nASSISTANT\nFinal answer');
});

test('trace tool reports a malformed complete record', async t => {
  const trace = await publishedTrace(t, traceReader, 'malformed\n' + conversation);
  await assert.rejects(trace.read(), /Damaged chat record at line 2/);
});

test('trace tool rejects a null record', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('u', null, 'user', 'kept'), null]));
  await assert.rejects(trace.read(), /Damaged chat record at line 3/);
});

test('trace tool rejects a boolean record', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('u', null, 'user', 'kept'), true]));
  await assert.rejects(trace.read(), /Damaged chat record at line 3/);
});

test('trace tool rejects a numeric record', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('u', null, 'user', 'kept'), 7]));
  await assert.rejects(trace.read(), /Damaged chat record at line 3/);
});

test('trace tool reads a cyclic parent only once', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('cycle', 'cycle', 'user', 'once')]));
  assert.equal((await trace.read()).content[0].text, 'USER\nonce');
});

test('trace tool retains an orphaned completed response', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('orphan', 'missing', 'assistant', 'orphan')]));
  assert.equal((await trace.read()).content[0].text, 'ASSISTANT\norphan');
});

test('trace tool reports that metadata contains no conversation', async t => {
  const trace = await publishedTrace(t, traceReader, lines([{}, { type: 'session' }]));
  await assert.rejects(trace.read(), /contains no user prompts or completed assistant messages/);
});

test('trace tool reports that absent message bodies contain no conversation', async t => {
  const trace = await publishedTrace(t, traceReader, lines([{ type: 'message', id: 'empty', parentId: null }, { type: 'message', id: 'null-body', parentId: 'empty', message: null }]));
  await assert.rejects(trace.read(), /contains no user prompts or completed assistant messages/);
});

test('trace tool warns about an interrupted write and returns completed messages', async t => {
  const trace = await publishedTrace(t, traceReader, conversation + '{"type":"mess');
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  assert.equal((await trace.read()).content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
  assert.deepEqual(warnings, [`${trace.path}: last write was interrupted; ignored 13 bytes`]);
});

test('trace lookup accepts a relative published path', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const result = await trace.read(relative(trace.home, trace.path));
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup expands a home-relative published path', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const result = await trace.read('~/' + relative(trace.home, trace.path));
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup accepts the exact published filename', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const result = await trace.read(basename(trace.path));
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup accepts the published filename without its extension', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const result = await trace.read(basename(trace.path, '.jsonl'));
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup finds a unique filename fragment', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const result = await trace.read(basename(trace.path).slice(-18, -6));
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup selects the latest registered conversation', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const older = await trace.publish(lines([message('old-user', null, 'user', 'Older conversation')]));
  await utimes(older, 1, 1);
  await utimes(trace.path, 2, 2);
  const result = await trace.read('latest');
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup reports no chats in an empty profile', async t => {
  const trace = await publishedTrace(t, traceReader);
  await assert.rejects(trace.read('latest'), /No Piop/);
});

test('trace lookup rejects a blank query', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  await assert.rejects(trace.read('  '), /cannot be empty/);
});

test('trace lookup reports a missing name', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  await assert.rejects(trace.read('missing-trace'), /No Piop/);
});

test('trace lookup rejects a chat containing only tool output', async t => {
  const trace = await publishedTrace(t, traceReader, lines([message('tool', null, 'toolResult', 'hidden')]));
  await assert.rejects(trace.read(), /no user prompts/);
});

test('trace lookup rejects an unregistered file path', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const path = join(trace.home, '.piop/sessions/unlisted.jsonl');
  await writeFile(path, lines([{ type: 'session', id: randomUUID() }]) + conversation);
  await assert.rejects(trace.read(path), /not registered or was deleted/);
});

test('trace lookup excludes unregistered files from name searches', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  await writeFile(join(trace.home, '.piop/sessions/unlisted.jsonl'), lines([{ type: 'session', id: randomUUID() }]) + conversation);
  await assert.rejects(trace.read('unlisted'), /No Piop/);
});

test('trace lookup rejects a replaced session identity', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const stored = await readFile(trace.path, 'utf8');
  const end = stored.indexOf('\n');
  const header = { ...JSON.parse(stored.slice(0, end)), id: randomUUID() };
  await writeFile(trace.path, JSON.stringify(header) + stored.slice(end));
  await assert.rejects(trace.read(), /no longer matches its registered session/);
});

test('trace lookup reads a conversation after the archive command moves it', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const archived = await trace.archive();
  const result = await trace.read(basename(archived, '.jsonl'));
  assert.equal(result.details.path, archived);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace latest lookup compares archived and active conversations', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const older = await trace.publish(lines([message('old-user', null, 'user', 'Archived question')]));
  const archived = await trace.archive(older);
  await utimes(archived, 1, 1);
  await utimes(trace.path, 2, 2);

  const result = await trace.read('latest');
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace lookup finds a unique project folder fragment', async t => {
  const trace = await publishedTrace(t, traceReader, conversation, { folder: 'project' });
  const result = await trace.read('project');
  assert.equal(result.details.path, trace.path);
  assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
});

test('trace tool refuses a transcript outside profile storage', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const outside = join(trace.home, 'outside.jsonl');
  await writeFile(outside, await readFile(trace.path));
  await assert.rejects(trace.read(outside), /not registered or was deleted/);
});

test('trace tool refuses a symlink that escapes profile storage', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const outside = join(trace.home, 'outside.jsonl');
  await writeFile(outside, await readFile(trace.path));
  const link = join(trace.home, '.piop/sessions/escape.jsonl');
  await symlink(outside, link);
  await assert.rejects(trace.read(link), /not registered or was deleted/);
});

test('trace tool refuses a directory as a transcript', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  await rm(trace.path);
  await mkdir(trace.path);
  await assert.rejects(trace.read(), /Only Piop traces/);
});

test('trace tool refuses a non-transcript file extension', async t => {
  const trace = await publishedTrace(t, traceReader, conversation);
  const wrong = join(trace.home, '.piop/sessions/wrong.txt');
  await writeFile(wrong, await readFile(trace.path));
  await assert.rejects(trace.read(wrong), /not registered or was deleted/);
});

test('trace lookup limits ambiguous results to twenty distinct registered choices', async t => {
  const trace = await publishedTrace(t, traceReader, conversation, { folder: 'matching' });
  const registered = new Set([trace.path]);
  for (let index = 0; index < 21; index++) registered.add(await trace.publish(conversation));

  const result = await trace.read('matching');
  assert.match(result.content[0].text, /More than one trace matched/);
  assert.equal(result.details.matches.length, 20);
  assert.equal(new Set(result.details.matches).size, 20);
  for (const path of result.details.matches) assert.ok(registered.has(path));
});
