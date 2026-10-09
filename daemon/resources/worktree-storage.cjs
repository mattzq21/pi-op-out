const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const [action, directory, storage, branch, revision = 'HEAD'] = process.argv.slice(1);

const root = path.join(os.homedir(), storage, 'worktrees');

function withCreationLock(operation) {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(path.dirname(root), 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');
    execFileSync('flock', ['--shared', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    return operation(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function cleanup(target) {
  const container = path.dirname(target);

  if (path.dirname(container) !== root || !/^[a-f0-9]{4}$/.test(path.basename(container))) return;

  require('./worktree-allocation.cjs').cleanup(target);
}


try {
  if (action === 'cleanup') withCreationLock(() => cleanup(directory));
  else if (['create', 'create-copy'].includes(action)) withCreationLock(() => {
    const target = require('./worktree-creation.cjs').create(path.dirname(root), fs.realpathSync(directory), branch, revision, action === 'create-copy');
    process.stdout.write(target);
  });
  else throw new Error('Unknown worktree storage operation');
} catch (error) { console.error(error.message); process.exitCode = 1; }
