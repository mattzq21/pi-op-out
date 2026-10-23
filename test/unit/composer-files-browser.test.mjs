import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startupPage } from '../startup-browser-fixture.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';

async function fileComposer(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  const reads = [], pending = new Set(), gates = new Map();
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/composer-files-browser.tsx', ready: '[aria-label="Message piop"]', holdStorage: false,
    prepare: page => page.exposeFunction('nativeCommand', async (command, args) => {
      if (command === 'read_dropped_file') reads.push(args.path);
      const gate = command === 'read_dropped_file' ? gates.get(args.path) : undefined;
      const request = native.invoke(command, args).finally(async () => {
        if (!gate) return;
        gate.held.resolve();
        await gate.release.promise;
      });
      pending.add(request);
      try { return await request; } finally { pending.delete(request); }
    }),
  });
  const holdRead = path => {
    const gate = { held: Promise.withResolvers(), release: Promise.withResolvers() };
    gates.set(path, gate);
    let timer;
    const held = Promise.race([gate.held.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native read of ${path} was not requested`)), 5000);
    })]).finally(() => clearTimeout(timer));
    t.after(() => gate.release.resolve());
    return { held, release: () => gate.release.resolve() };
  };
  const settle = async () => {
    do {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await Promise.allSettled([...pending]);
    } while (pending.size);
  };
  const directory = await mkdtemp(join(homedir(), 'piop-composer-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { page, directory, reads, settle, holdRead };
}

test('valid images are sent with their bytes and media type', async t => {
  const { page, directory } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const path = join(directory, 'image.png');
  await writeFile(path, Buffer.from(image, 'base64'));
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await page.getByRole('button', { name: 'Remove image.png', exact: true }).waitFor();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['', null, [{ type: 'image', data: image, mimeType: 'image/png', name: 'image.png' }]],
  ]);
});

test('native file drops convert physical coordinates before attaching files', async t => {
  const { page, directory } = await fileComposer(t);
  const display = await page.context().newCDPSession(page);
  try {
    await display.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
    assert.equal(await page.evaluate(() => devicePixelRatio), 2);
    const path = join(directory, 'native.txt');
    await writeFile(path, 'Native content');
    const box = await page.locator('.composer').boundingBox();
    await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
      path, position: { x: (box.x + box.width * .8) * 2, y: (box.y + box.height * .8) * 2 },
    });
    await page.getByRole('button', { name: 'Remove native.txt', exact: true }).waitFor();
    const editor = page.getByRole('textbox', { name: 'Message piop' });
    assert.equal(await editor.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
      ['<file name="native.txt">\nNative content\n</file>', null, []],
    ]);
  } finally { await display.detach(); }
});

test('native drops keep non-ASCII text and filenames intact', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'résumé.md');
  await writeFile(path, 'Café — 漢字 😀');
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await page.getByRole('button', { name: 'Remove résumé.md', exact: true }).waitFor();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="résumé.md">\nCafé — 漢字 😀\n</file>', null, []],
  ]);
});

test('native drag entry and leave update the visible attachment hint', async t => {
  const { page, directory, reads, settle } = await fileComposer(t);
  const path = join(directory, 'preview.txt');
  await writeFile(path, 'Preview');
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('enter', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  const hint = page.getByRole('status').filter({ hasText: 'Drop files to attach' });
  await hint.waitFor();
  await page.evaluate(() => window.deliverFileDrag('leave', {}));
  assert.equal(await hint.count(), 0);
  await settle();
  assert.deepEqual(reads, []);
});

test('native drop failures are visible while readable files remain attached', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'good.txt');
  await writeFile(path, 'Good');
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ paths, position }) => window.deliverFileDrag('drop', { paths, position }), {
    paths: [join(directory, 'missing.txt'), path], position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await page.getByRole('button', { name: 'Remove good.txt', exact: true }).waitFor();
  assert.match(await page.getByRole('alert').textContent(), /No such file or directory/);
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="good.txt">\nGood\n</file>', null, []],
  ]);
});

test('native drops outside the composer do not request file reads', async t => {
  const { page, directory, reads, settle } = await fileComposer(t);
  const path = join(directory, 'ignored.txt');
  await writeFile(path, 'Must not attach');
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width + 100, y: box.y + box.height / 2 },
  });
  await settle();
  assert.deepEqual(reads, []);
  assert.equal(await page.getByRole('button', { name: 'Remove ignored.txt', exact: true }).count(), 0);
});

test('disabled native drops do not read or attach files', async t => {
  const { page, directory, reads, settle } = await fileComposer(t);
  const path = join(directory, 'ignored.txt');
  await writeFile(path, 'Must not attach');
  const box = await page.locator('.composer').boundingBox();
  await page.getByRole('checkbox', { name: 'Disable controls' }).check();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await settle();
  assert.deepEqual(reads, []);
  assert.equal(await page.getByRole('button', { name: 'Remove ignored.txt', exact: true }).count(), 0);
});

test('unmounted composers stop receiving native file drops', async t => {
  const { page, directory, reads, settle } = await fileComposer(t);
  const path = join(directory, 'ignored.txt');
  await writeFile(path, 'Must not attach');
  const box = await page.locator('.composer').boundingBox();
  await page.getByRole('button', { name: 'Remove composer' }).click();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await settle();
  assert.deepEqual(reads, []);
  assert.equal(await page.getByRole('button', { name: 'Remove ignored.txt', exact: true }).count(), 0);
});

test('unmounting a composer during a native drop stops the remaining reads and upload changes', { timeout: 15000 }, async t => {
  const { page, directory, reads, settle, holdRead } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Controlled uploads' }).check();
  const first = join(directory, 'first.txt'), second = join(directory, 'second.txt');
  await writeFile(first, 'First');
  await writeFile(second, 'Second');
  const read = holdRead(first);
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ paths, position }) => window.deliverFileDrag('drop', { paths, position }), {
    paths: [first, second], position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await read.held;
  await page.getByRole('button', { name: 'Remove composer' }).click();
  read.release();
  await settle();
  assert.deepEqual(reads, [first]);
  assert.equal(await page.getByLabel('Uploaded files').textContent(), '[]');
});


test('an image rejected by the browser decoder is not attached', async t => {
  const { page, directory } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  const path = join(directory, 'bad.png');
  await writeFile(path, 'broken');
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  const error = page.getByRole('alert').filter({ hasText: 'bad.png is not a valid image' });
  await error.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove bad.png', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});


test('switching to a text-only model rejects an image still being decoded', async t => {
  const { page, directory } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    window.imageDecodeStarted = started.promise;
    window.releaseImageDecode = pending.resolve;
    HTMLImageElement.prototype.decode = async function () {
      started.resolve();
      await pending.promise;
      return decode.call(this);
    };
  });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const path = join(directory, 'slow.png');
  await writeFile(path, Buffer.from(image, 'base64'));
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  try {
    await page.evaluate(() => window.imageDecodeStarted);
    await page.getByRole('checkbox', { name: 'Image-capable model' }).uncheck();
  } finally { await page.evaluate(() => window.releaseImageDecode()); }
  await page.getByRole('alert').filter({ hasText: 'This model does not support image inputs' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove slow.png', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});


test('selecting an image-capable model permits an image-only submission', async t => {
  const { page, directory } = await fileComposer(t);
  const model = page.getByRole('checkbox', { name: 'Image-capable model' });
  await model.check();
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const path = join(directory, 'photo.png');
  await writeFile(path, Buffer.from(image, 'base64'));
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await page.getByRole('button', { name: 'Remove photo.png', exact: true }).waitFor();
  await model.uncheck();
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Dismiss image input error' }).waitFor();
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
  await model.check();
  assert.equal(await page.getByRole('button', { name: 'Dismiss image input error' }).count(), 0);
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['', null, [{ type: 'image', mimeType: 'image/png', data: image, name: 'photo.png' }]],
  ]);
});

test('ordinary text paste keeps the browser default behavior', async t => {
  const { page } = await fileComposer(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('plain text'));
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.focus();
  await page.keyboard.press('Control+v');
  await editor.evaluate(node => new Promise(resolve => {
    if (node.value === 'plain text') return resolve();
    node.addEventListener('input', resolve, { once: true });
  }));
  assert.equal(await editor.inputValue(), 'plain text');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});

test('pasting an image without a capable model shows a dismissible error', async t => {
  const { page } = await fileComposer(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const bytes = Uint8Array.from(atob(image), char => char.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  });
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Control+v');
  const dismiss = page.getByRole('button', { name: 'Dismiss image input error' });
  await dismiss.waitFor();
  assert.equal(await page.locator('.attachments button').count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
  await dismiss.click();
  assert.equal(await page.getByRole('alert').count(), 0);
});

test('disabled attachment input ignores pasted files', async t => {
  const { page } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  await page.getByRole('checkbox', { name: 'Disable controls' }).check();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const bytes = Uint8Array.from(atob(image), char => char.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    window.pastedFileCount = new Promise(resolve => document.addEventListener('paste', event => {
      resolve(event.clipboardData.files.length);
    }, { once: true }));
  });
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.focus();
  await page.keyboard.press('Control+v');
  assert.equal(await page.evaluate(() => window.pastedFileCount), 1);
  assert.equal(await page.locator('.attachments button').count(), 0);
  await page.getByRole('checkbox', { name: 'Disable controls' }).uncheck();
  await editor.fill('Continue');
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [['Continue', null, []]]);
});

async function browserFileDrop(page, paths, position) {
  const box = await page.getByRole('textbox', { name: 'Message piop' }).boundingBox();
  const drag = await page.context().newCDPSession(page);
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await drag.send('Input.dispatchDragEvent', {
        type, ...(position ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
        data: { items: [], files: paths, dragOperationsMask: 1 },
      });
    }
  } finally { await drag.detach(); }
}

test('unsupported image formats are rejected', async t => {
  const { page, directory } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  const path = join(directory, 'vector.svg');
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
  await browserFileDrop(page, [path]);
  await page.getByRole('alert').filter({ hasText: 'vector.svg uses an unsupported image format' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove vector.svg', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});

test('images above the image size limit are rejected', async t => {
  const { page, directory } = await fileComposer(t);
  await page.getByRole('checkbox', { name: 'Image-capable model' }).check();
  const path = join(directory, 'big.png');
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64').copy(bytes);
  await writeFile(path, bytes);
  await browserFileDrop(page, [path]);
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').textContent(), 'big.png is larger than 10 MB');
  assert.equal(await page.getByRole('button', { name: 'Remove big.png', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});

test('files above the total attachment size limit are rejected', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'huge.txt');
  await writeFile(path, Buffer.alloc(24 * 1024 * 1024 + 1, 'a'));
  await browserFileDrop(page, [path]);
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').textContent(), 'huge.txt exceeds the 24 MB attachment limit');
  assert.equal(await page.getByRole('button', { name: 'Remove huge.txt', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});

test('dropping a file attaches its content and focuses the editor', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'drop.txt');
  await writeFile(path, 'dropped text');
  await page.getByRole('checkbox', { name: 'Image-capable model' }).focus();
  await browserFileDrop(page, [path]);
  await page.getByRole('button', { name: 'Remove drop.txt', exact: true }).waitFor();
  assert.equal(await page.getByRole('status').filter({ hasText: 'Drop files to attach' }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="drop.txt">\ndropped text\n</file>', null, []],
  ]);
});

test('file dragging offers a copy operation', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'copy.txt');
  await writeFile(path, 'Copy me');
  await page.evaluate(() => {
    window.dragOperations = [];
    window.addEventListener('dragover', event => {
      window.dragOperations.push({ trusted: event.isTrusted, operation: event.dataTransfer.dropEffect });
    });
  });
  await browserFileDrop(page, [path]);
  await page.getByRole('button', { name: 'Remove copy.txt', exact: true }).waitFor();
  const operations = await page.evaluate(() => window.dragOperations);
  assert.ok(operations.length > 0);
  for (const operation of operations) assert.deepEqual(operation, { trusted: true, operation: 'copy' });
});

test('disabled file drops preserve existing attachments and reject new files', async t => {
  const { page, directory } = await fileComposer(t);
  const keep = join(directory, 'keep.txt'), ignored = join(directory, 'ignored.txt');
  await writeFile(keep, 'keep');
  await writeFile(ignored, 'ignored');
  await browserFileDrop(page, [keep]);
  await page.getByRole('button', { name: 'Remove keep.txt', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Disable controls' }).check();
  await page.evaluate(() => {
    window.dragOperations = [];
    window.addEventListener('dragover', event => {
      window.dragOperations.push({ trusted: event.isTrusted, operation: event.dataTransfer.dropEffect });
    });
  });
  await browserFileDrop(page, [ignored]);
  const operations = await page.evaluate(() => window.dragOperations);
  assert.ok(operations.length > 0);
  for (const operation of operations) assert.deepEqual(operation, { trusted: true, operation: 'none' });
  assert.equal(await page.getByRole('button', { name: 'Remove ignored.txt', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Remove keep.txt', exact: true }).count(), 1);
  await page.getByRole('checkbox', { name: 'Disable controls' }).uncheck();
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="keep.txt">\nkeep\n</file>', null, []],
  ]);
});

test('file drops outside the composer do not navigate the window', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'outside.txt');
  await writeFile(path, 'Stay in the app');
  const originalUrl = page.url();
  const box = await page.locator('.composer').boundingBox();
  await page.evaluate(() => {
    window.outsideDrop = new Promise(resolve => window.addEventListener('drop', event => {
      queueMicrotask(() => resolve({ trusted: event.isTrusted, prevented: event.defaultPrevented }));
    }, { once: true }));
  });
  await browserFileDrop(page, [path], { x: box.x - 50, y: box.y + box.height / 2 });
  assert.deepEqual(await page.evaluate(() => window.outsideDrop), { trusted: true, prevented: true });
  assert.equal(page.url(), originalUrl);
  assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Remove outside.txt', exact: true }).count(), 0);
});

test('ordinary text dragging retains the browser default behavior', async t => {
  const { page } = await fileComposer(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  const box = await editor.boundingBox();
  const drag = await page.context().newCDPSession(page);
  try {
    const data = { items: [{ mimeType: 'text/plain', data: 'dragged text' }], dragOperationsMask: 1 };
    await drag.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x + box.width / 2, y: box.y + box.height / 2, data });
    assert.equal(await page.getByRole('status').filter({ hasText: 'Drop files to attach' }).count(), 0);
    for (const type of ['dragOver', 'drop']) {
      await drag.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data });
    }
    assert.equal(await editor.inputValue(), 'dragged text');
    assert.equal(await page.locator('.attachments button').count(), 0);
    assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
  } finally { await drag.detach(); }
});

test('window blur clears the file drag hint', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'preview.txt');
  await writeFile(path, 'Preview');
  const drag = await page.context().newCDPSession(page);
  try {
    await drag.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.bringToFront();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    const box = await page.getByRole('textbox', { name: 'Message piop' }).boundingBox();
    await drag.send('Input.dispatchDragEvent', {
      type: 'dragEnter', x: box.x + box.width / 2, y: box.y + box.height / 2,
      data: { items: [], files: [path], dragOperationsMask: 1 },
    });
    const hint = page.getByRole('status').filter({ hasText: 'Drop files to attach' });
    await hint.waitFor();
    const other = await page.context().newPage();
    try {
      await other.bringToFront();
      assert.equal(await page.evaluate(() => document.hasFocus()), false);
      assert.equal(await hint.count(), 0);
      assert.equal(await page.locator('.attachments button').count(), 0);
    } finally { await other.close(); }
  } finally { await drag.detach(); }
});

test('file drag hints remain visible until the last nested drag leaves', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'preview.txt');
  await writeFile(path, 'Preview');
  const composer = await page.locator('.composer').boundingBox();
  const editor = await page.getByRole('textbox', { name: 'Message piop' }).boundingBox();
  const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  const drag = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    await drag.send('Input.dispatchDragEvent', { type: 'dragEnter', x: editor.x + editor.width / 2, y: editor.y + editor.height / 2, data });
    const hint = page.getByRole('status').filter({ hasText: 'Drop files to attach' });
    await hint.waitFor();
    for (const box of [send, editor]) {
      await drag.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x + box.width / 2, y: box.y + box.height / 2, data });
      assert.equal(await hint.isVisible(), true);
    }
    await drag.send('Input.dispatchDragEvent', { type: 'dragOver', x: composer.x - 50, y: composer.y + composer.height / 2, data });
    assert.equal(await hint.count(), 0);
    assert.equal(await page.locator('.attachments button').count(), 0);
  } finally { await drag.detach(); }
});

test('text attachments retain their contents and escape filenames when sent', async t => {
  const { page, directory } = await fileComposer(t);
  const name = `a&"<>'.ts`;
  const path = join(directory, name);
  await writeFile(path, 'const value = 1;');
  await browserFileDrop(page, [path]);
  const remove = page.getByRole('button', { name: `Remove ${name}`, exact: true });
  await remove.waitFor();
  await page.getByRole('textbox', { name: 'Message piop' }).fill('Review');
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['Review\n\n<file name="a&amp;&quot;&lt;&gt;&apos;.ts">\nconst value = 1;\n</file>', null, []],
  ]);
  assert.equal(await remove.count(), 0);
});

test('unsupported, oversized and corrupt text attachments are rejected without discarding valid files', async t => {
  const { page, directory } = await fileComposer(t);
  const files = [
    ['program.exe', 'x'], ['huge.txt', Buffer.alloc(200001, 'a')],
    ['encoding.txt', Buffer.from([255])], ['binary.txt', 'a\0b'], ['good.json', 'ok'],
  ];
  const paths = [];
  for (const [name, data] of files) {
    const path = join(directory, name);
    await writeFile(path, data);
    paths.push(path);
  }
  await browserFileDrop(page, paths);
  await page.getByRole('button', { name: 'Remove good.json', exact: true }).waitFor();
  const error = await page.getByRole('alert').textContent();
  assert.match(error, /program.exe is not a supported text file/);
  assert.match(error, /huge.txt is larger than 200 KB/);
  assert.match(error, /encoding.txt does not contain valid UTF-8/);
  assert.match(error, /binary.txt does not contain valid text/);
  assert.equal(await page.locator('.attachments button').count(), 1);
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="good.json">\nok\n</file>', null, []],
  ]);
});

test('the attachment count limit retains twelve files and rejects the excess', async t => {
  const { page, directory } = await fileComposer(t);
  const paths = [];
  for (let i = 0; i < 13; i++) {
    const path = join(directory, `${i}.txt`);
    await writeFile(path, 'text');
    paths.push(path);
  }
  await browserFileDrop(page, paths);
  await page.getByRole('alert').filter({ hasText: 'Only 12 attachments are allowed' }).waitFor();
  assert.deepEqual(await page.locator('.attachments button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), [
    'Remove 0.txt', 'Remove 1.txt', 'Remove 2.txt', 'Remove 3.txt',
    'Remove 4.txt', 'Remove 5.txt', 'Remove 6.txt', 'Remove 7.txt',
    'Remove 8.txt', 'Remove 9.txt', 'Remove 10.txt', 'Remove 11.txt',
  ]);
  assert.equal(await page.getByRole('button', { name: 'Remove 12.txt', exact: true }).count(), 0);
});

test('failed submission preserves an attachment for a later retry', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'note.txt');
  await writeFile(path, 'body');
  await page.getByRole('checkbox', { name: 'Fail sends' }).check();
  await browserFileDrop(page, [path]);
  const remove = page.getByRole('button', { name: 'Remove note.txt', exact: true });
  await remove.waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'offline' }).waitFor();
  assert.equal(await remove.count(), 1);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
  await page.getByRole('checkbox', { name: 'Fail sends' }).uncheck();
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="note.txt">\nbody\n</file>', null, []],
  ]);
  assert.equal(await remove.count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
});

test('an attachment added while a send is pending survives that send and is sent next', { timeout: 15000 }, async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'note.txt');
  const remove = page.getByRole('button', { name: 'Remove note.txt', exact: true });
  const sent = async () => JSON.parse(await page.getByLabel('Sent messages').textContent());
  await writeFile(path, 'first');
  await browserFileDrop(page, [path]);
  await remove.waitFor();
  await page.getByRole('checkbox', { name: 'Hold sends' }).check();
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Send message', exact: true }).and(page.locator(':disabled')).waitFor();
  await writeFile(path, 'second');
  await browserFileDrop(page, [path]);
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Remove note.txt"]').length === 2);
  await page.getByRole('button', { name: 'Complete send' }).click();
  await page.getByLabel('Sent messages').filter({ hasText: 'first' }).waitFor();
  assert.deepEqual(await sent(), [['<file name="note.txt">\nfirst\n</file>', null, []]]);
  assert.equal(await remove.count(), 1);
  await page.getByRole('checkbox', { name: 'Hold sends' }).uncheck();
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Sent messages').filter({ hasText: 'second' }).waitFor();
  assert.deepEqual(await sent(), [
    ['<file name="note.txt">\nfirst\n</file>', null, []],
    ['<file name="note.txt">\nsecond\n</file>', null, []],
  ]);
  assert.equal(await remove.count(), 0);
});

test('removing an attachment excludes it from the sent message', async t => {
  const { page, directory } = await fileComposer(t);
  const keep = join(directory, 'keep.txt'), discard = join(directory, 'remove.txt');
  await writeFile(keep, 'Keep');
  await writeFile(discard, 'Discard');
  await browserFileDrop(page, [keep, discard]);
  const remove = page.getByRole('button', { name: 'Remove remove.txt', exact: true });
  await remove.waitFor();
  await remove.click();
  assert.equal(await remove.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Remove keep.txt', exact: true }).count(), 1);
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="keep.txt">\nKeep\n</file>', null, []],
  ]);
});

test('removing an attachment clears the previous attachment error', async t => {
  const { page, directory } = await fileComposer(t);
  const bad = join(directory, 'program.exe'), good = join(directory, 'good.json');
  await writeFile(bad, 'invalid');
  await writeFile(good, 'valid');
  await browserFileDrop(page, [bad, good]);
  await page.getByRole('alert').filter({ hasText: 'program.exe is not a supported text file' }).waitFor();
  const remove = page.getByRole('button', { name: 'Remove good.json', exact: true });
  await remove.click();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await remove.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), []);
});

test('concurrent file reads respect the attachment count after earlier reads finish', async t => {
  const { page, directory } = await fileComposer(t);
  const slow = join(directory, 'slow.txt'), fast = [];
  await writeFile(slow, 'slow');
  for (let i = 0; i < 12; i++) {
    const path = join(directory, `fast${i}.txt`);
    await writeFile(path, 'fast');
    fast.push(path);
  }
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    const pending = Promise.withResolvers(), started = Promise.withResolvers();
    window.slowReadStarted = started.promise;
    window.releaseSlowRead = pending.resolve;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'slow.txt') { started.resolve(); await pending.promise; }
      return read.call(this);
    };
  });
  try {
    await browserFileDrop(page, [slow]);
    await page.evaluate(() => window.slowReadStarted);
    await browserFileDrop(page, fast);
    await page.getByRole('button', { name: 'Remove fast11.txt', exact: true }).waitFor();
  } finally { await page.evaluate(() => window.releaseSlowRead()); }
  await page.getByRole('alert').filter({ hasText: 'Only 12 attachments are allowed' }).waitFor();
  assert.deepEqual(await page.locator('.attachments button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), [
    'Remove fast0.txt', 'Remove fast1.txt', 'Remove fast2.txt', 'Remove fast3.txt',
    'Remove fast4.txt', 'Remove fast5.txt', 'Remove fast6.txt', 'Remove fast7.txt',
    'Remove fast8.txt', 'Remove fast9.txt', 'Remove fast10.txt', 'Remove fast11.txt',
  ]);
  assert.equal(await page.getByRole('button', { name: 'Remove slow.txt', exact: true }).count(), 0);
});

test('dropping a file again after a failed native read attaches it and clears the error', async t => {
  const { page, directory } = await fileComposer(t);
  const path = join(directory, 'later.txt');
  const box = await page.locator('.composer').boundingBox();
  const drop = () => page.evaluate(({ path, position }) => window.deliverFileDrag('drop', { paths: [path], position }), {
    path, position: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  });
  await drop();
  const error = page.getByRole('alert').filter({ hasText: 'No such file or directory' });
  await error.waitFor();
  assert.equal(await page.locator('.attachments button').count(), 0);
  await writeFile(path, 'Ready now');
  await drop();
  await page.getByRole('button', { name: 'Remove later.txt', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages').textContent()), [
    ['<file name="later.txt">\nReady now\n</file>', null, []],
  ]);
});
