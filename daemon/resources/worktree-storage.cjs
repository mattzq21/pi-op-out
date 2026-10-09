const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
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

function allocate() {
  let parentBranch = null;

  try { parentBranch = execFileSync('git', ['-C', directory, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { }

  const listed = execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const worktrees = listed.split('\0').filter((entry) => entry.startsWith('worktree ')).map((entry) => entry.slice(9));

  if (!worktrees.length) throw new Error('Could not locate the main checkout');
  const project = path.basename(worktrees[0]);

  if (!project) throw new Error('Git repository directory has no name');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  require('./session-database.cjs').markCleanup(path.dirname(root), 'worktree');
  const container = path.join(root, randomUUID().slice(0, 4));
  const target = path.join(container, project);

  if (worktrees.includes(target)) throw new Error(`Git worktree is already registered: ${target}`);

  require('./worktree-allocation.cjs').create(container, target, branch, parentBranch);

  return target;
}

function create(descriptor) {
  const target = allocate();

  try {
    const args = ['worktree', 'add', ...(revision === '--orphan' ? ['--orphan'] : []), '-b', branch, '--', target];

    if (revision !== '--orphan') args.push(revision);
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe', descriptor] });
    process.stdout.write(target);
  } finally { cleanup(target); }
}

try {
  if (action === 'cleanup') withCreationLock(() => cleanup(directory));
  else if (action === 'create') withCreationLock(create);
  else throw new Error('Unknown worktree storage operation');
} catch (error) { console.error(error.message); process.exitCode = 1; }
