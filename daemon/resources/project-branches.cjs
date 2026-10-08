const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [cwd, storage, selected] = process.argv.slice(1);

const git = (args, descriptor) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe', ...(descriptor === undefined ? [] : [descriptor])] });

function withCreationLock(operation) {
  const root = path.join(os.homedir(), storage);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');
    execFileSync('flock', ['--shared', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    return operation(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function worktrees() {
  return git(['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map((record) => {
    const fields = record.split('\0');

    return { path: fields.find((field) => field.startsWith('worktree '))?.slice(9), branch: fields.find((field) => field.startsWith('branch refs/heads/'))?.slice(18) };
  });
}

function checkout(branch, trees, descriptor) {
  const existing = trees.find((tree) => tree.branch === branch);

  if (existing) {
    if (!existing.path || !fs.existsSync(existing.path)) throw new Error('The branch worktree is unavailable');

    return existing.path;
  }

  const root = path.join(os.homedir(), storage, 'worktrees');
  const project = path.basename(trees[0].path);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  require('./session-database.cjs').markCleanup(path.dirname(root), 'worktree');
  const container = path.join(root, randomUUID().slice(0, 4));

  try { fs.mkdirSync(container, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Worktree directory already exists: ${container}`); throw error; }

  const target = path.join(container, project);

  try {
    try { fs.lstatSync(target); throw new Error(`Worktree directory already exists: ${target}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    recordAllocation(container, target, branch);
    git(['worktree', 'add', '--', target, branch], descriptor);

    return target;
  } catch (error) { cleanupAllocation(container, target);

  throw error; }
}

function recordAllocation(container, target, branch) {
  const info = fs.lstatSync(container, { bigint: true });
  const allocation = { version: 1, identity: `${info.dev}:${info.ino}`, target };
  const temporary = path.join(container, `.parent-v1-${info.dev}-${info.ino}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ branch, parentBranch: null, allocation }), { flag: 'wx', mode: 0o600, flush: true });
  fs.renameSync(temporary, path.join(container, 'parent.json'));

  for (const directory of [container, path.dirname(container), path.dirname(path.dirname(container))]) {
    const descriptor = fs.openSync(directory, 'r');

    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }
}

function cleanupAllocation(container, target) {
  if (fs.existsSync(target)) return;

  try { fs.unlinkSync(path.join(container, 'parent.json')); } catch { }

  try { fs.rmdirSync(container); } catch { }
}

try {
  let root;

  try { root = git(['rev-parse', '--show-toplevel']).trim(); }
  catch { if (selected) throw new Error('Project is not a Git repository'); process.stdout.write('null'); process.exit(0); }

  const branches = git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']).trim().split('\n').filter(Boolean);
  let current = null;

  try { current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { }

  if (selected && !branches.includes(selected)) throw new Error('Branch no longer exists');
  const trees = worktrees();
  const directory = selected ? withCreationLock(descriptor => checkout(selected, worktrees(), descriptor)) : root;
  process.stdout.write(JSON.stringify({ branches, current: selected || current, path: directory, mainPath: trees[0].path }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
