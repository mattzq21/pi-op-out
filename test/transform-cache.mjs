import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function cachedTransform(implementation, transform) {
  let cacheDirectory;
  return (source, filename) => {
    const root = process.env.PIOP_TEST_TRANSFORM_CACHE_DIR;
    if (!root) return transform(source, filename);
    if (!cacheDirectory) {
      const version = createHash('sha256').update(readFileSync(implementation))
        .update(readFileSync(new URL('../bun.lock', import.meta.url))).update(readFileSync(new URL('./transform-cache.mjs', import.meta.url))).update(process.version).digest('hex');
      cacheDirectory = join(root, version);
      mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    }
    const key = createHash('sha256').update(filename).update('\0').update(source).digest('hex');
    const target = join(cacheDirectory, key + '.js');
    try { return readFileSync(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const code = transform(source, filename);
    const temporary = target + '.' + randomUUID();
    try {
      writeFileSync(temporary, code, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
    return code;
  };
}
