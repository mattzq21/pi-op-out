import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
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
