import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

/** Builds the release desktop app of this worktree and installs its .deb over the installed Piop. */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'target/release/bundle/deb');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });

  if (result.error) throw new Error('Could not run ' + command + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed');
}

let keepAlive;

try {
  console.log('Installing needs sudo. Enter your password now, before the build starts.');
  run('sudo', ['-v']);
  // Keeps the sudo login fresh during a long build, so the install does not ask again. It has its own process group, so stopping it also stops its sleep.
  keepAlive = spawn('sh', ['-c', 'while sleep 60; do sudo -n -v || exit; done'], { stdio: 'ignore', detached: true });
  const started = Date.now();
  console.log('Building the Piop release app in ' + root + '…');
  run(process.execPath, ['run', 'build']);
  const packages = existsSync(bundle) ? readdirSync(bundle).filter(name => name.endsWith('.deb')).map(name => join(bundle, name)) : [];
  const newest = packages.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

  if (!newest || statSync(newest).mtimeMs < started) throw new Error('The build made no new .deb in ' + bundle);
  console.log('Installing ' + newest + '…');
  run('sudo', ['dpkg', '-i', newest]);
  console.log('Piop release installed. Restart Piop to use it. App data in ~/.piop is kept.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (keepAlive?.exitCode === null) process.kill(-keepAlive.pid, 'SIGTERM');
}
