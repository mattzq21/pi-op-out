import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadAppSettings } from './settings';
import { remoteHost, remoteLoginCommand, ssh } from './pi_launch';
import { runLimited, shellQuote } from './process_io';
import type { App } from './app';

const IMAGE_LIMIT = 10 * 1024 * 1024;

export async function readImage(app: App, cwd: string, path: string, hostId: string): Promise<string> {
  const bytes = hostId === 'local' ? readLocalImage(cwd, path) : await readRemoteImage(app, cwd, path, hostId);
  if (bytes.length > IMAGE_LIMIT) throw new Error('Image is larger than 10 MB');
  return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
}

function readLocalImage(cwd: string, path: string): Buffer {
  const target = isAbsolute(path) ? path : join(cwd, path);
  let fd: number;
  try { fd = openSync(target, 'r'); } catch (error: any) { throw new Error(`Could not read image: ${error.message}`); }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('Select a regular image file');
    if (stats.size > IMAGE_LIMIT) throw new Error('Image is larger than 10 MB');
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

async function readRemoteImage(app: App, cwd: string, path: string, hostId: string): Promise<Buffer> {
  const settings = await loadAppSettings(app);
  const host = remoteHost(settings, hostId);
  const script = "const fs=require('fs'),p=require('path');const fd=fs.openSync(p.resolve(process.argv[1],process.argv[2]),'r');const s=fs.fstatSync(fd);if(!s.isFile()||s.size>10485760)throw Error('Select an image file up to 10 MB');const b=Buffer.alloc(10485761);let n=0,k;while(n<b.length&&(k=fs.readSync(fd,b,n,b.length-n,null)))n+=k;fs.closeSync(fd);process.stdout.write(b.subarray(0,n));";
  const command = `bun -e ${shellQuote(script)} ${shellQuote(cwd)} ${shellQuote(path)}`;
  const result = await runLimited(ssh(host, remoteLoginCommand(command)), IMAGE_LIMIT + 1, 'Could not read image');
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  return result.stdout;
}

function imageMime(bytes: Buffer): string {
  const starts = (prefix: number[] | string) => Buffer.from(prefix as any).equals(bytes.subarray(0, typeof prefix === 'string' ? prefix.length : prefix.length));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (starts('RIFF') && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  throw new Error('Unsupported image format');
}
