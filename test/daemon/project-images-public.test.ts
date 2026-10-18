import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type TestDaemon } from './harness';

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

test('images outside the project are refused however the path reaches them, except saved goal images', async () => {
  writeFileSync(join(daemon.home, 'private.png'), png);
  symlinkSync(join(daemon.home, 'private.png'), join(project, 'docs/linked.png'));
  for (const path of ['../private.png', join(daemon.home, 'private.png'), 'docs/linked.png', 'docs/../../private.png']) {
    expect(await daemon.failure('read_image_file', { hostId: 'local', cwd: project, path })).toBe('Image is outside the project');
  }
  const goal = join(daemon.home, '.piop/sessions/project/attachments/goal-a1B2c3');
  mkdirSync(goal, { recursive: true });
  writeFileSync(join(goal, 'mockup.png'), png);
  writeFileSync(join(daemon.home, '.piop/sessions/project/other.png'), png);
  expect(await readImage(join(goal, 'mockup.png'))).toBe('data:image/png;base64,' + png.toString('base64'));
  expect(await daemon.failure('read_image_file', { hostId: 'local', cwd: project, path: join(daemon.home, '.piop/sessions/project/other.png') })).toBe('Image is outside the project');
}, 60000);

test('files that are not images, or are over 10 MB, are refused with the reason', async () => {
  writeFileSync(join(project, 'docs/notes.png'), 'just text');
  writeFileSync(join(project, 'docs/huge.png'), Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]));
  const failure = (path: string) => daemon.failure('read_image_file', { hostId: 'local', cwd: project, path });
  expect(await failure('docs/notes.png')).toBe('Unsupported image format');
  expect(await failure('docs/huge.png')).toBe('Image is larger than 10 MB');
  expect(await failure('docs')).toBe('Select a regular image file');
}, 60000);
