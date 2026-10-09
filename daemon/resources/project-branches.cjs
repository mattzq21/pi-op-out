const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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


try {
  let root;

  try { root = git(['rev-parse', '--show-toplevel']).trim(); }
  catch { if (selected) throw new Error('Project is not a Git repository'); process.stdout.write('null'); process.exit(0); }

  const branches = git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']).trim().split('\n').filter(Boolean);
  let current = null;

  try { current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { }

  if (selected && !branches.includes(selected)) throw new Error('Branch no longer exists');
  const trees = worktrees();
  const directory = selected ? withCreationLock(() => require('./worktree-creation.cjs').checkout(path.join(os.homedir(), storage), fs.realpathSync(root), selected)) : root;
  process.stdout.write(JSON.stringify({ branches, current: selected || current, path: directory, mainPath: trees[0].path }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
