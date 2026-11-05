import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { installName, installPi } = require('../daemon/resources/pi/install.ts');
const { SUPPORTED_PI_VERSION } = require('../daemon/resources/pi/install.ts');
const manifest = readFileSync(new URL('../daemon/resources/pi/package.json', import.meta.url), 'utf8');
const lockfile = readFileSync(new URL('../daemon/resources/pi/bun.lock', import.meta.url), 'utf8');
const name = installName(manifest, lockfile);
// Tests share one install in the user's cache. Tests change HOME, so the user's home comes from the account.
const shared = join(userInfo().homedir, '.cache', 'piop', 'test-pi');
let installed;

// The Pi that the daemon installs, installed once for all tests.
export function testPi() {
  if (process.env.PIOP_TEST_DAEMON_UNIT) throw new Error('A daemon unit test must not install Pi');
  installed ??= installPi({ home: shared, manifest, lockfile, bun: 'bun' }).catch(error => { installed = undefined; throw error; });
  return installed;
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Gives a test home the shared Pi, where the daemon looks for its own Pi. A Pi that the test put there stays.
export async function linkTestPi(home) {
  await testPi();
  const target = join(home, '.piop', 'pi', name);
  if (exists(target)) return;
  mkdirSync(join(home, '.piop', 'pi'), { recursive: true });
  symlinkSync(join(shared, '.piop', 'pi', name), target, 'dir');
}

// A Pi that only has a version and a program, where the daemon looks for its own Pi. Returns the program.
export function fakePi(home, version = SUPPORTED_PI_VERSION, program = '#!/bin/sh\nexit 1\n') {
  const directory = join(home, '.piop', 'pi', name);
  rmSync(directory, { recursive: true, force: true });
  const root = join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, bin: { pi: 'dist/bundle/cli.js' } }));
  const cli = join(root, 'dist', 'bundle', 'cli.js');
  writeFileSync(cli, program, { mode: 0o755 });
  return cli;
}
