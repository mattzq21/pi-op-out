import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
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
copyFileSync(new URL(`../src-tauri/target/${debug ? 'debug' : 'release'}/piopd${extension}`, import.meta.url), new URL(`../src-tauri/binaries/piopd-${triple}${extension}`, import.meta.url));
