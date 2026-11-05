import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_PI_VERSION, supportedPi } from './pi-runtime.ts';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const PENDING = /^\.install-(\d+)-(\d+)-[0-9a-f-]{36}$/;

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

// The folder name of one install: the Pi version, and a hash of the exact list of packages.
function installName(manifest: string, lockfile: string): string {
  return SUPPORTED_PI_VERSION + '-' + createHash('sha256').update(manifest).update('\0').update(lockfile).digest('hex').slice(0, 12);
}

function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

// Pi in a finished install folder, after its version is checked.
function piIn(directory) {
  const manifestFile = join(directory, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const program = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
  if (typeof program !== 'string') throw new Error(`${manifestFile} names no pi program`);
  const { root } = supportedPi(join(manifestFile, '..', program));
  return { root, cli: join(root, program) };
}

// Removes the install folders of processes that stopped before they finished.
function removeAbandoned(installs) {
  for (const name of readdirSync(installs)) {
    const owner = PENDING.exec(name);
    if (owner && startTime(Number(owner[1])) !== owner[2]) rmSync(join(installs, name), { recursive: true, force: true });
  }
}

function run(bun, cwd, env) {
  const args = ['install', '--frozen-lockfile', '--production', '--ignore-scripts', '--no-progress', '--no-summary'];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bun, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = chunk => { output = (output + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Could not run ${bun} to install Pi: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Could not install Pi ${SUPPORTED_PI_VERSION} (${signal ? 'stopped by ' + signal : 'exit code ' + code}): ${output.trim() || 'no output'}`));
    });
  });
}

// Piop's own copy of Pi, in ~/.piop/pi/<version>-<hash>. It is installed on first use and not changed after.
async function installPi({ home, manifest, lockfile, bun, env = process.env, log = () => {} }: { home: string; manifest: string; lockfile: string; bun: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): Promise<{ root: string; cli: string }> {
  const installs = join(home, '.piop', 'pi');
  const directory = join(installs, installName(manifest, lockfile));
  try { return piIn(directory); } catch (error) { if (!missing(error)) throw error; }
  mkdirSync(installs, { recursive: true, mode: 0o700 });
  removeAbandoned(installs);
  const temporary = join(installs, `.install-${process.pid}-${startTime(process.pid)}-${randomUUID()}`);
  mkdirSync(temporary);
  try {
    writeFileSync(join(temporary, 'package.json'), manifest);
    writeFileSync(join(temporary, 'bun.lock'), lockfile);
    log(`Installing Pi ${SUPPORTED_PI_VERSION} into ${directory}`);
    await run(bun, temporary, { ...env, BUN_BE_BUN: '1', BUN_INSTALL_CACHE_DIR: join(temporary, '.cache') });
    rmSync(join(temporary, '.cache'), { recursive: true, force: true });
    piIn(temporary);
    // Another process can finish the same install first. Its folder has the same packages.
    try { renameSync(temporary, directory); } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error; }
    return piIn(directory);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export { installName, installPi };
