import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';
import { cleanupScope } from '../cleanup-scope.mjs';

const resources = cleanupScope({ after });
let rejectionNative;

for (const [description, target] of [
  ['a missing target', null],
  ['a missing session ID', {}],
  ['a null session ID', { sessionId: null }],
  ['a numeric session ID', { sessionId: 7 }],
  ['an empty session ID', { sessionId: '' }],
  ['a whitespace session ID', { sessionId: ' \n\t' }],
]) test(`opening a conversation window rejects ${description}`, async () => {
  const native = await (rejectionNative ??= nativeFileCommand(resources, { desktop: true }));
  await assert.rejects(native.invoke('new_window', { target }), { message: 'Select a conversation to open in another window' });
});

test('a new window receives special characters as one complete conversation target', async t => {
  const observed = Promise.withResolvers();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/observed') {
      observed.resolve(url.searchParams.get('url'));
      response.end('ok');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<script>fetch("/observed?url="+encodeURIComponent(location.href))</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const native = await nativeFileCommand(t, { desktop: true, desktopUrl: `http://127.0.0.1:${server.address().port}` });
  const target = { sessionId: 'session & # ? = + / λ', sessionPath: "/project's files/a?b#c.jsonl", hostId: 'remote', name: 'hello\n世界', nested: { value: '%26target=other' } };
  const label = await native.invoke('new_window', { target });
  assert.ok(typeof label === 'string' && label.length > 0);
  const opened = new URL(await observed.promise);
  assert.equal(opened.pathname, '/index.html');
  assert.equal(opened.hash, '');
  assert.deepEqual([...opened.searchParams.keys()], ['target']);
  assert.deepEqual(JSON.parse(opened.searchParams.get('target')), target);
});

test('opening the same conversation twice creates two distinct windows', async t => {
  const loaded = Promise.withResolvers();
  const firstLoaded = Promise.withResolvers();
  let documents = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/loaded') {
      documents++;
      if (documents === 1) firstLoaded.resolve();
      if (documents === 2) loaded.resolve();
      response.end('ok');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<script>fetch("/loaded")</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const native = await nativeFileCommand(t, { desktop: true, desktopUrl: `http://127.0.0.1:${server.address().port}` });
  const first = await native.invoke('new_window', { target: { sessionId: 'same-conversation' } });
  await firstLoaded.promise;
  const second = await native.invoke('new_window', { target: { sessionId: 'same-conversation' } });
  await loaded.promise;
  assert.equal(documents, 2);
  assert.ok(typeof first === 'string' && first.length > 0);
  assert.ok(typeof second === 'string' && second.length > 0);
  assert.notEqual(first, second);
});
