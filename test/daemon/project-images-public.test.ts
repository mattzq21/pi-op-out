import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteMachine, startDaemon, useRemotes } from './harness';

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

test('after the project folder is gone, an image read still gives goal attachment images from active and archived storage, and rejects other stored images', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'deleted-project');
    const folder = '--' + cwd.slice(1).replaceAll('/', '-') + '--';
    const storage = join(daemon.home, '.piop');
    const active = join(storage, 'sessions', folder, 'attachments', 'goal-a1b2c3');
    const archived = join(storage, 'archived', folder, 'attachments', 'goal-' + 'd4'.repeat(32));
    const lookalike = join(storage, 'sessions', folder, 'attachments', 'goal-a1b2c');
    for (const directory of [active, archived, lookalike]) mkdirSync(directory, { recursive: true });
    // Different bytes in each file, so a read of the wrong file shows.
    const image = (marker: number) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([marker])]);
    writeFileSync(join(active, 'attachment-1.png'), image(1));
    writeFileSync(join(archived, 'attachment-2.png'), image(2));
    writeFileSync(join(lookalike, 'attachment-1.png'), image(3));
    writeFileSync(join(storage, 'sessions', folder, 'photo.png'), image(4));
    const read = (path: string) => ({ hostId: 'local', cwd, path });

    expect(await daemon.invoke('read_image_file', read(join(active, 'attachment-1.png')))).toBe('data:image/png;base64,' + image(1).toString('base64'));
    expect(await daemon.invoke('read_image_file', read(join(archived, 'attachment-2.png')))).toBe('data:image/png;base64,' + image(2).toString('base64'));
    expect(await daemon.failure('read_image_file', read(join(lookalike, 'attachment-1.png')))).toBe('Image is outside the project');
    expect(await daemon.failure('read_image_file', read(join(storage, 'sessions', folder, 'photo.png')))).toBe('Image is outside the project');
  } finally { await daemon.stop(); }
}, 60_000);

test('an image read for a remote machine whose project folder is gone gives a goal attachment image from the storage of that machine, which the local machine rejects', async () => {
  const daemon = await startDaemon();
  try {
    const server = await remoteMachine(daemon, 'server', 'Server');
    try {
      await useRemotes(daemon, [server]);
      const cwd = join(server.home, 'deleted-project');
      const folder = '--' + cwd.slice(1).replaceAll('/', '-') + '--';
      const sessions = join(server.home, '.piop', 'sessions', folder);
      const attachments = join(sessions, 'attachments', 'goal-a1b2c3');
      mkdirSync(attachments, { recursive: true });
      // Different bytes in each file, so a read of the wrong file shows.
      const image = (marker: number) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([marker])]);
      writeFileSync(join(attachments, 'attachment-1.png'), image(1));
      writeFileSync(join(sessions, 'photo.png'), image(2));
      const read = (hostId: string, path: string) => ({ hostId, cwd, path });

      expect(await daemon.invoke('read_image_file', read('server', join(attachments, 'attachment-1.png')))).toBe('data:image/png;base64,' + image(1).toString('base64'));
      expect(await daemon.failure('read_image_file', read('server', join(sessions, 'photo.png')))).toBe('Image is outside the project');
      // The same file is outside the storage of the local machine.
      expect(await daemon.failure('read_image_file', read('local', join(attachments, 'attachment-1.png')))).toBe('Image is outside the project');
    } finally { await useRemotes(daemon, []); await server.stop(); }
  } finally { await daemon.stop(); }
}, 60_000);
