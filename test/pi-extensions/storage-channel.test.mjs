import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLines } from '../../daemon/resources/lf-lines.cjs';

const channel = fileURLToPath(new URL('../../daemon/resources/storage-channel.cjs', import.meta.url));

// Runs calls in a child process, as Pi does, while this process answers on the channel as the daemon does.
function run(source, answer, env = { PIOP_STORAGE_CHANNEL: '3' }) {
  const child = spawn(process.execPath, ['-e', `const { call } = require(${JSON.stringify(channel)});\n${source}`], {
    env: { ...process.env, PIOP_STORAGE_CHANNEL: '', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const requests = [];
  readLines(child.stdio[3], line => {
    const request = JSON.parse(line);
    requests.push(request);
    child.stdio[3].write(JSON.stringify(answer(request)) + '\n');
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return new Promise(resolve => child.on('close', code => resolve({ code, output: output.trim(), requests })));
}

test('a storage call waits for the daemon and returns its answer, in order', async () => {
  const { code, output, requests } = await run(`
    const answers = [];
    for (let index = 0; index < 50; index++) answers.push(call('transcript.bind', { index, text: 'x'.repeat(index * 4000) }));
    console.log(JSON.stringify(answers.map(answer => answer.index)));
  `, request => ({ result: { index: request.payload.index } }));
  assert.equal(code, 0, output);
  assert.deepEqual(JSON.parse(output), [...Array(50).keys()]);
  assert.deepEqual(requests.map(request => [request.operation, request.payload.text.length]), [...Array(50).keys()].map(index => ['transcript.bind', index * 4000]));
});

test('a refused change reaches Pi as an error, and says when the saved chat may no longer match', async () => {
  const { code, output } = await run(`
    for (const operation of ['transcript.append', 'transcript.publish']) {
      try { call(operation, {}); } catch (error) { console.log(error.message + ' damaged=' + (error.damaged === true)); }
    }
  `, request => request.operation === 'transcript.append' ? { error: 'The saved session changed unexpectedly.', damaged: true } : { error: 'Invalid transcript path', damaged: false });
  assert.equal(code, 0, output);
  assert.deepEqual(output.split('\n'), ['The saved session changed unexpectedly. damaged=true', 'Invalid transcript path damaged=false']);
});

test('a Pi that the daemon did not start cannot save chats, and says why', async () => {
  const { code, output } = await run(`try { call('transcript.bind', {}); } catch (error) { console.log(error.message); }`, () => ({ result: null }), {});
  assert.equal(code, 0, output);
  assert.equal(output, 'Pi was not started by the Piop daemon, so it cannot save');
});

test('a Pi reads the database that the daemon made, a write that skips the daemon fails at once, and programs that Pi starts get no channel', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const database = fileURLToPath(new URL('../../daemon/resources/session-database.cjs', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'piop-read-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { connection } = (await import('../../daemon/resources/session-database.cjs')).default;
  connection(root).prepare("INSERT INTO application_settings (name, body) VALUES ('daemon', 'saved')").run();
  const { code, output } = await run(`
    const db = require(${JSON.stringify(database)}).connection(${JSON.stringify(root)});
    console.log(String(db.prepare("SELECT body FROM application_settings WHERE name='daemon'").get().body));
    try { db.prepare("INSERT INTO application_settings (name, body) VALUES ('pi', 'saved')").run(); } catch (error) { console.log(error.message); }
    console.log(require('node:child_process').execFileSync(process.execPath, ['-p', 'process.env.PIOP_STORAGE_CHANNEL'], { encoding: 'utf8' }).trim());
  `, () => ({ result: null }));
  assert.equal(code, 0, output);
  assert.deepEqual(output.split('\n'), ['saved', 'attempt to write a readonly database', 'undefined']);
});
