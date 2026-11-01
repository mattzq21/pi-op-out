import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const RRWEB_VERSION = '2.1.7';

export function cacheDir() {
  const root = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(root, 'piop-rrweb', RRWEB_VERSION);
}

function packageDir(name) {
  return path.join(cacheDir(), name.replace('@', '').replace('/', '-'), 'package');
}

export function bundlePaths() {
  return {
    record: path.join(packageDir('@rrweb/record'), 'dist', 'record.umd.min.cjs'),
    replay: path.join(packageDir('@rrweb/replay'), 'dist', 'replay.umd.min.cjs'),
    replayCss: path.join(packageDir('@rrweb/replay'), 'dist', 'style.min.css'),
  };
}

export function ensureBundles({ quiet = false } = {}) {
  const paths = bundlePaths();
  if (Object.values(paths).every(p => fs.existsSync(p))) return paths;
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!quiet) process.stderr.write(`Fetching rrweb ${RRWEB_VERSION} bundles into ${dir}\n`);
  for (const name of ['@rrweb/record', '@rrweb/replay']) {
    const target = path.join(dir, name.replace('@', '').replace('/', '-'));
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const out = execFileSync('npm', ['pack', `${name}@${RRWEB_VERSION}`, '--pack-destination', target, '--silent'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const tarball = path.join(target, out.trim().split('\n').pop());
    execFileSync('tar', ['-xzf', tarball, '-C', target]);
    fs.rmSync(tarball);
  }
  for (const p of Object.values(paths)) {
    if (!fs.existsSync(p)) throw new Error(`rrweb bundle missing after fetch: ${p}`);
  }
  return paths;
}
