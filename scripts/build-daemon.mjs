import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const debug = process.argv.includes('--debug');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);

  return result;
}

const triple = run('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout.match(/^host: (.+)$/m)?.[1];

if (!triple) throw new Error('Could not determine the native Rust target');

run('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--target-dir', 'src-tauri/target', '--no-default-features', '--features', 'daemon', '--bin', 'piopd', ...(debug ? [] : ['--release'])]);

const extension = process.platform === 'win32' ? '.exe' : '';

mkdirSync(new URL('../src-tauri/binaries/', import.meta.url), { recursive: true });

const source = new URL(`../src-tauri/target/${debug ? 'debug' : 'release'}/piopd${extension}`, import.meta.url);
const destination = new URL(`../src-tauri/binaries/piopd-${triple}${extension}`, import.meta.url);
let unchanged = false;

try {
  unchanged = statSync(destination).size === statSync(source).size && readFileSync(destination).equals(readFileSync(source));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (!unchanged) copyFileSync(source, destination);

if (process.argv.includes('--install')) {
  const binDirectory = join(homedir(), '.local', 'bin');
  const installed = join(binDirectory, `piopd${extension}`);
  const temporary = join(binDirectory, `.piopd-${randomUUID()}${extension}`);
  mkdirSync(binDirectory, { recursive: true });

  try {
    copyFileSync(source, temporary);
    renameSync(temporary, installed);
  } finally {
    rmSync(temporary, { force: true });
  }

  console.log(`Installed ${installed}`);

  if (!(process.env.PATH ?? '').split(delimiter).some(directory => resolve(directory) === binDirectory)) {
    console.warn(`Add ${binDirectory} to your PATH to run piopd directly.`);
  }
}
