import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const debug = process.argv.includes('--debug');

if (!process.argv.includes('--skip-extensions')) run(process.execPath, ['scripts/build-extensions.mjs']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);

  return result;
}

const triple = run('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout.match(/^host: (.+)$/m)?.[1];

if (!triple) throw new Error('Could not determine the native Rust target');

run('cargo', ['build', '--locked', '--manifest-path', 'Cargo.toml', '--target-dir', 'target', '-p', 'piop-daemon', '--bin', 'piopd', ...(debug ? [] : ['--release'])]);

const extension = process.platform === 'win32' ? '.exe' : '';

mkdirSync(new URL('../clients/desktop/binaries', import.meta.url), { recursive: true });

const source = fileURLToPath(new URL(`../target/${debug ? 'debug' : 'release'}/piopd${extension}`, import.meta.url));

const destination = fileURLToPath(new URL(`../clients/desktop/binaries/piopd-${triple}${extension}`, import.meta.url));

const sourceStats = statSync(source);

let sourceContent;

function copyIfChanged(target) {
  try {
    const targetStats = statSync(target);

    if (targetStats.size === sourceStats.size && (process.platform === 'win32' || (targetStats.mode & 0o111) === (sourceStats.mode & 0o111))) {
      sourceContent ??= readFileSync(source);

      if (readFileSync(target).equals(sourceContent)) return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = join(dirname(target), `.piopd-${randomUUID()}${extension}`);

  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }

  return true;
}

copyIfChanged(destination);

if (process.argv.includes('--install')) {
  const binDirectory = join(homedir(), '.local', 'bin');
  const installed = join(binDirectory, `piopd${extension}`);
  mkdirSync(binDirectory, { recursive: true });

  console.log(`${copyIfChanged(installed) ? 'Installed' : 'Unchanged:'} ${installed}`);

  if (!(process.env.PATH ?? '').split(delimiter).some(directory => resolve(directory) === binDirectory)) {
    console.warn(`Add ${binDirectory} to your PATH to run piopd directly.`);
  }
}
