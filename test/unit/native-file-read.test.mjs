import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, truncate, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { installDom } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { cleanupScope } from '../cleanup-scope.mjs';
import { readDroppedFile } from '../../clients/ui/lib/nativeTransport.ts';

const resources = cleanupScope({ after });
let native;
before(async () => { native = await nativeFileCommand(resources); });

async function reader(t) {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  mockIPC((command, args) => native.invoke(command, args), { background: false });
  return native.directory;
}

for (const [description, name, type, content = 'AB', size = 2] of [
  ['reading an uppercase PNG filename preserves its name, type and contents', 'picture.PNG', 'image/png'],
  ['reading a JPEG file supplies its image type and original contents', 'a.jpeg', 'image/jpeg'],
  ['reading a JPG file supplies the JPEG type and original contents', 'photo.jpg', 'image/jpeg'],
  ['reading a GIF file supplies its image type and original contents', 'animation.gif', 'image/gif'],
  ['reading a text file does not label it as an image', 'a.txt', ''],
  ['reading a filename without an extension does not label it as an image', 'png', ''],
  ['reading an empty text file preserves its name and zero length', 'empty.txt', '', '', 0],
]) test(description, async t => {
  const directory = await reader(t);
  const path = join(directory, name);
  await writeFile(path, content);
  const file = await readDroppedFile(path);
  assert.equal(file.name, name);
  assert.equal(file.type, type);
  assert.equal(file.size, size);
  assert.equal(await file.text(), content);
});

test('reading a binary image returns a file with its exact original bytes', async t => {
  const directory = await reader(t);
  const path = join(directory, 'scan.webp');
  await writeFile(path, Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x0a, 0xc3]));
  const file = await readDroppedFile(path);
  assert.equal(file.type, 'image/webp');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x0a, 0xc3]);
});

test('reading a file over the attachment size limit reports the limit', async t => {
  const directory = await reader(t);
  const path = join(directory, 'too-large.png');
  await writeFile(path, '');
  await truncate(path, 10_485_761);
  await assert.rejects(readDroppedFile(path), { message: 'Attachment is larger than 10 MB' });
});

test('reading a named pipe rejects without waiting for a writer, and later files still read', async t => {
  const directory = await reader(t);
  const pipe = join(directory, 'pipe.txt');
  await promisify(execFile)('mkfifo', [pipe]);
  let timer;
  t.after(() => clearTimeout(timer));
  const hung = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      // A blocked native open waits for a writer; opening one releases the bridge so cleanup can finish.
      try { await (await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK)).close(); } catch {}
      reject(new Error('Reading a named pipe did not settle within 3 s'));
    }, 3000);
  });
  await assert.rejects(Promise.race([readDroppedFile(pipe), hung]), { message: 'Drop regular files only' });
  clearTimeout(timer);
  const path = join(directory, 'after.txt');
  await writeFile(path, 'AB');
  assert.equal(await (await readDroppedFile(path)).text(), 'AB');
});
