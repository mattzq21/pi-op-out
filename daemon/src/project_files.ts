import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const IMAGE_LIMIT = 25 * 1024 * 1024;

export async function readImage(cwd: string, path: string): Promise<string> {
  const bytes = readLocalImage(cwd, path);
  if (bytes.length > IMAGE_LIMIT) throw new Error('Image is larger than 25 MB');
  return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
}

function readLocalImage(cwd: string, path: string): Buffer {
  const target = realpathSync(resolve(cwd, path));
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK); } catch (error: any) { throw new Error(`Could not read image: ${error.message}`); }
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (realpathSync('/proc/self/fd/' + fd) !== target) throw new Error('Image file changed while opening');
    if (!stats.isFile()) throw new Error('Select a regular image file');
    if (stats.size > IMAGE_LIMIT) throw new Error('Image is larger than 25 MB');
    const buffer = Buffer.alloc(IMAGE_LIMIT + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length >= buffer.length) break;
    }
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

function imageMime(bytes: Buffer): string {
  const starts = (prefix: number[] | string) => Buffer.from(prefix as any).equals(bytes.subarray(0, typeof prefix === 'string' ? prefix.length : prefix.length));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (starts('RIFF') && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  throw new Error('Unsupported image format');
}
