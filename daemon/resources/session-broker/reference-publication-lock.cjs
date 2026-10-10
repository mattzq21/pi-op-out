const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function openReference(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');

    return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function command(descriptor, shared, nonblocking) {
  const options = nonblocking ? ['--nonblock', '--conflict-exit-code', '75'] : [];

  return { args: [shared ? '--shared' : '--exclusive', ...options, '3'], options: { stdio: ['ignore', 'pipe', 'pipe', descriptor] } };
}

function finish(descriptor, status, stderr, nonblocking) {
  if (nonblocking && status === 75) { fs.closeSync(descriptor);

    return; }

  if (status !== 0) throw new Error(stderr.trim() || 'Could not lock reference publication');

  return () => fs.closeSync(descriptor);
}

function acquireReferencePublicationLock(root, shared = false, nonblocking = false) {
  const descriptor = openReference(root);

  try {
    const invocation = command(descriptor, shared, nonblocking);
    const locked = spawnSync('flock', invocation.args, invocation.options);

    if (locked.error) throw locked.error;

    return finish(descriptor, locked.status, locked.stderr.toString(), nonblocking);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

async function acquireReferencePublicationLockAsync(root) {
  const descriptor = openReference(root);

  try {
    const invocation = command(descriptor, true, false);

    const locked = await new Promise((resolve, reject) => {
      const child = spawn('flock', invocation.args, invocation.options);
      const stderr = [];

      child.stdout.resume();
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', status => resolve({ status, stderr: Buffer.concat(stderr).toString() }));
    });

    return finish(descriptor, locked.status, locked.stderr, false);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

module.exports = { acquireReferencePublicationLock, acquireReferencePublicationLockAsync };
