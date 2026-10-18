import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from './harness';

// A real 1x1 PNG image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('an image read that failed for a missing, folder or non-image path succeeds with the exact bytes once the path holds an image', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'project');
    mkdirSync(join(cwd, 'folder.png'), { recursive: true });
    const read = (path: string) => ({ hostId: 'local', cwd, path });

    expect(await daemon.failure('read_image_file', read('photo.png'))).toContain('ENOENT');
    expect(await daemon.failure('read_image_file', read('folder.png'))).toBe('Select a regular image file');
    writeFileSync(join(cwd, 'photo.png'), 'GIF8 is not a picture');
    expect(await daemon.failure('read_image_file', read('photo.png'))).toBe('Unsupported image format');

    writeFileSync(join(cwd, 'photo.png'), Buffer.from(PNG, 'base64'));
    expect(await daemon.invoke('read_image_file', read('photo.png'))).toBe('data:image/png;base64,' + PNG);
  } finally { await daemon.stop(); }
}, 60_000);

test('an image read rejects a sibling folder that shares the project name prefix and a link that leaves the project, and accepts a link to an image in the project', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'project');
    const sibling = join(daemon.home, 'project-sibling');
    mkdirSync(join(cwd, 'images'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.png'), Buffer.from(PNG, 'base64'));
    writeFileSync(join(cwd, 'images', 'real.png'), Buffer.from(PNG, 'base64'));
    symlinkSync(join(sibling, 'secret.png'), join(cwd, 'escape.png'));
    symlinkSync(join('images', 'real.png'), join(cwd, 'alias.png'));
    const read = (path: string) => ({ hostId: 'local', cwd, path });

    expect(await daemon.failure('read_image_file', read('../project-sibling/secret.png'))).toBe('Image is outside the project');
    expect(await daemon.failure('read_image_file', read('escape.png'))).toBe('Image is outside the project');
    expect(await daemon.invoke('read_image_file', read('alias.png'))).toBe('data:image/png;base64,' + PNG);
  } finally { await daemon.stop(); }
}, 60_000);

test('an image read accepts a PNG of exactly 10 MiB with all its bytes, rejects one byte more, and then reads a small image at the same path', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'project');
    mkdirSync(cwd, { recursive: true });
    const read = { hostId: 'local', cwd, path: 'large.png' };
    // A PNG signature, then a repeating pattern so a lost, added or moved byte changes the content.
    const large = Buffer.alloc(10_485_760, Buffer.from(Array.from({ length: 251 }, (_, index) => index)));
    Buffer.from(PNG, 'base64').copy(large, 0, 0, 8);
    writeFileSync(join(cwd, 'large.png'), large);

    const url: string = await daemon.invoke('read_image_file', read);
    expect(url.slice(0, 41)).toBe('data:image/png;base64,iVBORw0KGgoICQoLDA0');
    const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    expect(bytes.length).toBe(10_485_760);
    expect(bytes.equals(large)).toBe(true);

    writeFileSync(join(cwd, 'large.png'), Buffer.concat([large, Buffer.from([0])]));
    expect(await daemon.failure('read_image_file', read)).toBe('Image is larger than 10 MB');

    writeFileSync(join(cwd, 'large.png'), Buffer.from(PNG, 'base64'));
    expect(await daemon.invoke('read_image_file', read)).toBe('data:image/png;base64,' + PNG);
  } finally { await daemon.stop(); }
}, 60_000);
