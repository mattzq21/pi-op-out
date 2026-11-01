import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteMachine, startDaemon, useRemotes, type TestDaemon } from './harness';

let daemon: TestDaemon;
let project: string;
beforeAll(async () => {
  daemon = await startDaemon();
  project = join(daemon.home, 'project');
  mkdirSync(join(project, 'docs'), { recursive: true });
}, 60000);
afterAll(async () => { await daemon?.stop(); });

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const readImage = (path: string, cwd = project) => daemon.invoke('read_image_file', { hostId: 'local', cwd, path });

test('a project image is sent as a data URL typed by its content, not its name', async () => {
  writeFileSync(join(project, 'docs/chart.jpg'), png);
  expect(await readImage('docs/chart.jpg')).toBe('data:image/png;base64,' + png.toString('base64'));
  expect(await readImage(join(project, 'docs/chart.jpg'))).toBe('data:image/png;base64,' + png.toString('base64'));
}, 60000);

test('an image anywhere the user can read is sent, through relative paths, absolute paths and links', async () => {
  writeFileSync(join(daemon.home, 'private.png'), png);
  symlinkSync(join(daemon.home, 'private.png'), join(project, 'docs/linked.png'));
  for (const path of ['../private.png', join(daemon.home, 'private.png'), 'docs/linked.png', 'docs/../../private.png']) {
    expect(await readImage(path)).toBe('data:image/png;base64,' + png.toString('base64'));
  }
}, 60000);

test('files that are not images, or are over 25 MB, are refused with the reason', async () => {
  writeFileSync(join(project, 'docs/notes.png'), 'just text');
  writeFileSync(join(project, 'docs/huge.png'), Buffer.concat([png, Buffer.alloc(25 * 1024 * 1024)]));
  const failure = (path: string) => daemon.failure('read_image_file', { hostId: 'local', cwd: project, path });
  expect(await failure('docs/notes.png')).toBe('Unsupported image format');
  expect(await failure('docs/huge.png')).toBe('Image is larger than 25 MB');
  expect(await failure('docs')).toBe('Select a regular image file');
}, 60000);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.concurrent('an image read that failed for a missing, folder or non-image path succeeds with the exact bytes once the path holds an image', async () => {
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

test.concurrent('an image read accepts a PNG of exactly 25 MiB with all its bytes, rejects one byte more, and then reads a small image at the same path', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'project');
    mkdirSync(cwd, { recursive: true });
    const read = { hostId: 'local', cwd, path: 'large.png' };
    const large = Buffer.alloc(26_214_400, Buffer.from(Array.from({ length: 251 }, (_, index) => index)));
    Buffer.from(PNG, 'base64').copy(large, 0, 0, 8);
    writeFileSync(join(cwd, 'large.png'), large);

    const url: string = await daemon.invoke('read_image_file', read);
    expect(url.slice(0, 41)).toBe('data:image/png;base64,iVBORw0KGgoICQoLDA0');
    const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    expect(bytes.length).toBe(26_214_400);
    expect(bytes.equals(large)).toBe(true);

    writeFileSync(join(cwd, 'large.png'), Buffer.concat([large, Buffer.from([0])]));
    expect(await daemon.failure('read_image_file', read)).toBe('Image is larger than 25 MB');

    writeFileSync(join(cwd, 'large.png'), Buffer.from(PNG, 'base64'));
    expect(await daemon.invoke('read_image_file', read)).toBe('data:image/png;base64,' + PNG);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('after the project folder is gone, an image read still gives images by absolute path', async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.home, 'deleted-project');
    const shots = join(daemon.home, 'shot');
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, 'nav.png'), Buffer.from(PNG, 'base64'));
    expect(await daemon.invoke('read_image_file', { hostId: 'local', cwd, path: join(shots, 'nav.png') })).toBe('data:image/png;base64,' + PNG);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('an image read for a remote machine whose project folder is gone gives an image from that machine', async () => {
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
      const image = (marker: number) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([marker])]);
      writeFileSync(join(attachments, 'attachment-1.png'), image(1));
      const read = (hostId: string, path: string) => ({ hostId, cwd, path });

      expect(await daemon.invoke('read_image_file', read('server', join(attachments, 'attachment-1.png')))).toBe('data:image/png;base64,' + image(1).toString('base64'));
    } finally { await useRemotes(daemon, []); await server.stop(); }
  } finally { await daemon.stop(); }
}, 60_000);
