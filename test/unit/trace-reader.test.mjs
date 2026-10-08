import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/resources/trace-reader.ts')) {
      if (specifier === 'node:os') return { url: 'data:text/javascript,export const homedir = () => globalThis.__TRACE_TEST_HOME__', shortCircuit: true };

      if (specifier === '@earendil-works/pi-ai') return { url: 'data:text/javascript,export const Type = { Object: properties => ({properties}), String: options => ({type:"string",...options}), Integer: options => ({type:"integer",...options}), Optional: schema => schema }', shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});

const { default: traceReader, cleanTrace } = await import('../../daemon/resources/trace-reader.ts');

hooks.deregister();

const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, message: { role, content, ...extra } });

const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n');

const conversation = lines([message('user', null, 'user', 'Question'), message('answer', 'user', 'assistant', 'Answer')]);

test('trace cleaning follows the active branch and removes synthetic and intermediate messages', () => {
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

  assert.deepEqual(cleanTrace(`malformed\n${lines(entries)}\n`), [{ role: 'user', text: 'Original' }, { role: 'assistant', text: 'Final answer' }]);
  assert.deepEqual(cleanTrace(lines([message('cycle', 'cycle', 'user', 'once')])), [{ role: 'user', text: 'once' }]);
  assert.deepEqual(cleanTrace(lines([message('orphan', 'missing', 'assistant', 'orphan')])), [{ role: 'assistant', text: 'orphan' }]);
  assert.deepEqual(cleanTrace(lines([null, true, 7, {}, { type: 'session' }])), []);
  assert.deepEqual(cleanTrace(lines([{ type: 'message', id: 'empty', parentId: null }, { type: 'message', id: 'null-body', parentId: 'empty', message: null }])), []);
});

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'piop-traces-')); globalThis.__TRACE_TEST_HOME__ = home;
  let tool; traceReader({ registerTool(value) { tool = value; } });
  assert.equal(tool.name, 'read_trace');
  const execute = query => tool.execute('call', { query }, undefined, undefined, { cwd: home });

  const save = async (path, content = conversation) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content);

  return path; };

  try { await run({ home, execute, save }); }
  finally { delete globalThis.__TRACE_TEST_HOME__; await rm(home, { recursive: true, force: true }); }
}

test('trace tool resolves paths, exact names, unique fragments and latest across archive and sessions', async () => fixture(async ({ home, execute, save }) => {
  await assert.rejects(execute('latest'), /No Piop/);
  await assert.rejects(execute('  '), /cannot be empty/);
  const session = await save(join(home, '.piop/sessions/project/chat.jsonl'));
  const archived = await save(join(home, '.piop/archived/older.jsonl'));
  await utimes(archived, 1, 1); await utimes(session, 2, 2);

  for (const query of [session, '.piop/sessions/project/chat.jsonl', '~/.piop/sessions/project/chat.jsonl', 'chat', 'chat.jsonl', 'project', 'latest']) {
    const result = await execute(query);
    assert.equal(result.details.path, session);
    assert.equal(result.content[0].text, 'USER\nQuestion\n\nASSISTANT\nAnswer');
  }

  assert.equal((await execute('older')).details.path, archived);
  await assert.rejects(execute('missing'), /No Piop/);
  await save(join(home, '.piop/sessions/empty.jsonl'), lines([message('tool', null, 'toolResult', 'hidden')]));
  await assert.rejects(execute('empty'), /no user prompts/);
}));

test('trace tool limits ambiguous choices and rejects paths escaping storage', async () => fixture(async ({ home, execute, save }) => {
  const outside = await save(join(home, 'outside.jsonl'));
  const root = join(home, '.piop/sessions'); await mkdir(root, { recursive: true });
  await symlink(outside, join(root, 'escape.jsonl'));

  for (const path of [outside, join(root, 'escape.jsonl'), root]) await assert.rejects(execute(path), /Only Piop traces/);
  const wrong = await save(join(root, 'wrong.txt')); await assert.rejects(execute(wrong), /Only Piop traces/);

  for (let index = 0; index < 22; index++) await save(join(root, `match-${index}.jsonl`));
  const result = await execute('match');
  assert.equal(result.details.matches.length, 20);
  assert.match(result.content[0].text, /More than one trace matched/);
  assert.ok(result.details.matches.every(path => path.startsWith(root)));
}));
