import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'piop-html-preview-'));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = await build({ entryPoints: ['extensions/piop-html-preview/index.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['@earendil-works/*'],
  plugins: [{ name: 'pi-ai', setup(api) { api.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: 'pi-ai', namespace: 'sdk' })); api.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: 'export { Type } from "typebox";', resolveDir: process.cwd() })); } }] });
await writeFile(join(dir, 'extension.mjs'), bundle.outputFiles[0].contents);
const { default: htmlPreview } = await import(pathToFileURL(join(dir, 'extension.mjs')));

function load() {
  const tools = [], messages = [], listeners = [];
  htmlPreview({ registerTool: tool => tools.push(tool), sendMessage: (message, options) => messages.push({ message, options }), events: { on: (channel, handler) => { assert.equal(channel, 'piop:rpc'); listeners.push(handler); } } });
  const viewport = size => { const request = { command: 'html_preview_viewport', payload: { size } }; for (const listener of listeners) listener(request); return request.ready; };
  const run = params => tools.at(-1).execute('call', params, undefined, undefined, { cwd: dir });
  return { tools, messages, viewport, run };
}

test('a preview from inline HTML or a file is saved as a chat message', async () => {
  const preview = load();
  const inline = await preview.run({ html: '<p>hi</p>', title: '  Chart  ' });
  assert.deepEqual(preview.messages[0], { message: { customType: 'piop-html-preview', content: 'Chart', display: true, details: { version: 1, html: '<p>hi</p>', title: 'Chart' } }, options: { triggerTurn: false } });
  assert.equal(inline.content[0].text, 'Displayed Chart in the chat (600×600 on desktop; placeholder on mobile).');
  await writeFile(join(dir, 'page.html'), '<b>file</b>');
  await preview.run({ path: 'page.html' });
  assert.deepEqual(preview.messages[1].message.details, { version: 1, html: '<b>file</b>', title: 'HTML preview' });
});

test('invalid previews fail without a message', async () => {
  const preview = load();
  await mkdir(join(dir, 'folder'), { recursive: true });
  await writeFile(join(dir, 'large.html'), 'x'.repeat(512_001));
  for (const [params, error] of [[{}, /exactly one/], [{ html: 'a', path: 'b' }, /exactly one/], [{ path: ' ' }, /cannot be empty/], [{ html: '  ' }, /HTML cannot be empty/], [{ path: 'folder' }, /regular file/], [{ path: 'large.html' }, /512,000 bytes/], [{ html: 'é'.repeat(256_001) }, /512,000 bytes/]]) {
    await assert.rejects(preview.run(params), error);
  }
  assert.equal(preview.messages.length, 0);
});

test('the client viewport size changes the tool description and is kept across reloads', async () => {
  const preview = load();
  assert.deepEqual(await preview.viewport(750), { width: 750, height: 750 });
  assert.match(preview.tools.at(-1).description, /750×750/);
  const reloaded = load();
  assert.match(reloaded.tools.at(-1).description, /750×750/);
  assert.deepEqual(await reloaded.viewport('bad'), { width: 600, height: 600 });
  assert.match(reloaded.tools.at(-1).description, /600×600/);
});
