import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installDom } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { readDroppedFile } from '../../clients/ui/lib/nativeTransport.ts';

async function reader(t) {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const native = await nativeFileCommand(t);
  mockIPC((command, args) => native.invoke(command, args), { background: false });
  return native.directory;
}

test('reading an uppercase PNG filename preserves its name, type and contents', async t => {
  const directory = await reader(t);
  const path = join(directory, 'picture.PNG');
  await writeFile(path, 'AB');
  const file = await readDroppedFile(path);
  assert.equal(file.name, 'picture.PNG');
  assert.equal(file.type, 'image/png');
  assert.equal(await file.text(), 'AB');
});

test('reading a JPEG file supplies its image type and original contents', async t => {
  const directory = await reader(t);
  const path = join(directory, 'a.jpeg');
  await writeFile(path, 'AB');
  const file = await readDroppedFile(path);
  assert.equal(file.name, 'a.jpeg');
  assert.equal(file.type, 'image/jpeg');
  assert.equal(await file.text(), 'AB');
});

test('reading a text file does not label it as an image', async t => {
  const directory = await reader(t);
  const path = join(directory, 'a.txt');
  await writeFile(path, 'AB');
  const file = await readDroppedFile(path);
  assert.equal(file.name, 'a.txt');
  assert.equal(file.type, '');
  assert.equal(await file.text(), 'AB');
});

test('reading a binary image returns a file with its exact original bytes', async t => {
  const directory = await reader(t);
  const path = join(directory, 'scan.webp');
  await writeFile(path, Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x0a, 0xc3]));
  const file = await readDroppedFile(path);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x0a, 0xc3]);
});
