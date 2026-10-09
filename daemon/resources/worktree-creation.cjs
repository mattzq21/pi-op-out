const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const database = require('./session-database.cjs');
const allocation = require('./worktree-allocation.cjs');
const io = require('./session-transactions.cjs');

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function open(root) {
  const db = database.open(root);
  db.exec('CREATE TABLE IF NOT EXISTS worktree_creations (target TEXT PRIMARY KEY, record_json TEXT NOT NULL)');

  return db;
}

function save(root, plan) {
  const db = open(root);

  try {
    const result = db.prepare("INSERT INTO worktree_creations VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET record_json=excluded.record_json WHERE json_extract(worktree_creations.record_json, '$.id')=json_extract(excluded.record_json, '$.id')").run(plan.target, JSON.stringify(plan));

    if (result.changes !== 1) throw new Error('Worktree creation record belongs to another operation');
  }
  finally { db.close(); }
}

function locked(root, operation, optional = false) {
  io.mkdir(root);
  const fd = fs.openSync(path.join(root, 'worktree-creation.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    try { execFileSync('flock', ['--exclusive', ...(optional ? ['--nonblock'] : []), '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }); }
    catch (error) { if (optional && error.status === 1) return; throw error; }

    return operation(fd);
  } finally { fs.closeSync(fd); }
}

function validPath(name) {
  if (!name || path.isAbsolute(name) || name.split('/').some(part => ['.', '..', '.git', ''].includes(part))) throw new Error('Invalid worktree file path');

  return name;
}

function sourceFile(source, name) {
  const file = path.join(source, validPath(name));
  let info;

  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }

  if (info.isSymbolicLink()) return { name, mode: '120000', body: fs.readlinkSync(file, { encoding: 'buffer' }).toString('base64') };

  if (!info.isFile()) throw new Error(`Unsupported worktree copy entry: ${file}`);

  return { name, mode: info.mode & 0o111 ? '100755' : '100644', body: fs.readFileSync(file).toString('base64') };
}

function sourceFiles(source, rawName) {
  const name = validPath(rawName.replace(/\/$/, ''));
  const file = path.join(source, name);
  let info;

  try { info = fs.lstatSync(file); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; }

  if (info.isDirectory()) return [{ name, mode: '160000', body: null }, ...fs.readdirSync(file).filter(child => child !== '.git').flatMap(child => sourceFiles(source, name + '/' + child))];

  return [sourceFile(source, name)];
}

function baseFiles(source, base) {
  if (!base) return [];

  return git(source, ['ls-tree', '-rz', '--full-tree', base]).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, kind, object] = entry.slice(0, tab).split(' ');
    const name = validPath(entry.slice(tab + 1));

    if (kind === 'commit') return { name, mode, body: null };

    return { name, mode, body: git(source, ['cat-file', 'blob', object], { encoding: 'buffer' }).toString('base64') };
  });
}

function capture(source, base, copy) {
  const baseline = baseFiles(source, base);

  if (!copy) return baseline;
  const names = git(source, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const submodules = new Set(baseline.filter(file => file.mode === '160000').map(file => file.name));

  const files = [...new Set(names)].flatMap(name => {
    if (submodules.has(name)) return baseline.filter(file => file.name === name);

    return sourceFiles(source, name);
  });

  return files;
}

function newPlan(root, source, branch, revision, copy) {
  git(source, ['check-ref-format', '--branch', branch]);

  if (git(source, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]).trim()) throw new Error('Git branch already exists');
  const base = revision === '--orphan' ? null : git(source, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const container = path.join(root, 'worktrees', randomUUID().slice(0, 4));
  const target = path.join(container, path.basename(source));

  if (io.exists(container) || database.worktreeMetadata(container) || pending(root).some(plan => plan.container === container)) throw new Error('Worktree container is already reserved');
  let parentBranch = null;

  try { parentBranch = git(source, ['symbolic-ref', '--quiet', 'HEAD']).trim(); } catch { }

  const common = fs.realpathSync(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const plan = { id: randomUUID(), source, common, commonIdentity: io.identity(common), branch, base, parentBranch, container, target, files: capture(source, base, copy), phase: 'planned' };
  save(root, plan);

  return plan;
}

function prepare(root, plan, fd) {
  preserveBase(plan);
  io.mkdir(path.dirname(plan.container));

  if (!database.worktreeMetadata(plan.container)) allocation.create(plan.container, plan.target, plan.branch, plan.parentBranch);
  const saved = database.worktreeMetadata(plan.container);

  if (saved.creating || saved.containerIdentity !== io.identity(plan.container)) throw new Error('Worktree allocation changed; retained');
  plan.containerIdentity = saved.containerIdentity;
  save(root, plan);

  createGitWorktree(plan, fd);

  const actual = git(plan.target, ['symbolic-ref', 'HEAD']).trim();

  if (actual !== `refs/heads/${plan.branch}`) throw new Error('Created worktree branch changed; retained');
  const gitDirectory = git(plan.target, ['rev-parse', '--absolute-git-dir']).trim();
  io.syncTree(gitDirectory);
  io.sync(path.dirname(gitDirectory));
  io.sync(plan.target);
  io.sync(plan.container);
  plan.targetIdentity = io.identity(plan.target);
  plan.phase = 'copying';
  save(root, plan);
}

function createGitWorktree(plan, fd) {
  repairEmptyWorktree(plan);

  if (!io.exists(plan.target)) {
    const existing = git(plan.source, ['for-each-ref', '--format=%(objectname)', `refs/heads/${plan.branch}`]).trim();

    if (existing && existing !== plan.base) throw new Error('Worktree branch changed; retained');
    const args = ['worktree', 'add', '--no-checkout', ...(plan.base ? existing ? [] : ['-b', plan.branch] : ['--orphan', '-b', plan.branch]), '--', plan.target];

    if (plan.base) args.push(existing ? plan.branch : plan.base);
    git(plan.source, args, { stdio: ['ignore', 'pipe', 'pipe', fd] });
  }

}

function verifyEmptyWorktree(target) {
  const info = fs.lstatSync(target);

  if (!info.isDirectory() || process.getuid && info.uid !== process.getuid() || fs.readdirSync(target).length) throw new Error('Unexpected incomplete worktree contents; retained');
}

function restoreGitPointer(plan, registration) {
  const temporary = path.join(plan.container, 'copy-gitdir');
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);

  try { fs.writeFileSync(fd, `gitdir: ${registration}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }

  fs.linkSync(temporary, path.join(plan.target, '.git'));
  fs.unlinkSync(temporary);
  io.syncTree(plan.target);
  io.sync(plan.container);
}

function repairEmptyWorktree(plan) {
  if (!io.exists(plan.target) || io.exists(path.join(plan.target, '.git'))) return;
  verifyEmptyWorktree(plan.target);
  const registrations = path.join(plan.common, 'worktrees');
  const candidates = io.exists(registrations) ? fs.readdirSync(registrations) : [];

  for (const name of candidates) {
    const registration = path.join(registrations, name);
    const pointer = path.join(registration, 'gitdir');

    if (!io.exists(pointer) || fs.readFileSync(pointer, 'utf8').trim() !== path.join(plan.target, '.git')) continue;
    const head = fs.readFileSync(path.join(registration, 'HEAD'), 'utf8').trim();
    const common = fs.realpathSync(path.resolve(registration, fs.readFileSync(path.join(registration, 'commondir'), 'utf8').trim()));

    if (head !== `ref: refs/heads/${plan.branch}` || common !== plan.common) throw new Error('Incomplete worktree registration changed; retained');
    restoreGitPointer(plan, registration);

    return;
  }

  fs.rmdirSync(plan.target);
  io.sync(plan.container);
}

function preserveBase(plan) {
  if (!plan.base) return;
  const ref = `refs/piop-worktree-creations/${plan.id}`;
  const current = git(plan.common, ['for-each-ref', '--format=%(objectname)', ref]).trim();

  if (current && current !== plan.base) throw new Error('Worktree creation reference changed');

  if (!current) git(plan.common, ['update-ref', ref, plan.base, '0'.repeat(plan.base.length)]);
}

function verifyTarget(plan) {
  if (io.identity(plan.container) !== plan.containerIdentity || io.identity(plan.target) !== plan.targetIdentity || fs.realpathSync(plan.target) !== plan.target) throw new Error('Worktree directory changed; retained');
  const common = fs.realpathSync(git(plan.target, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const branch = git(plan.target, ['symbolic-ref', 'HEAD']).trim();
  const tip = git(plan.common, ['for-each-ref', '--format=%(objectname)', `refs/heads/${plan.branch}`]).trim();

  if (common !== plan.common || branch !== `refs/heads/${plan.branch}` || tip !== (plan.base ?? '')) throw new Error('Worktree Git ownership changed; retained');
}

function parents(plan, name) {
  let directory = plan.target;

  for (const part of name.split('/').slice(0, -1)) {
    directory = path.join(directory, part);

    if (!io.exists(directory)) { fs.mkdirSync(directory); io.sync(path.dirname(directory)); }

    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Worktree file parent changed: ${directory}`);
  }
}

function createSubdirectory(destination) {
  if (!io.exists(destination)) { fs.mkdirSync(destination); io.sync(path.dirname(destination)); }

  if (!fs.lstatSync(destination).isDirectory()) throw new Error(`Worktree directory changed: ${destination}`);
}

function writeFile(plan, file, index) {
  parents(plan, file.name);
  const destination = path.join(plan.target, validPath(file.name));

  if (file.mode === '160000') return createSubdirectory(destination);

  const current = sourceFile(plan.target, file.name);

  if (current) {
    if (current.body !== file.body || current.mode !== file.mode) throw new Error(`Worktree file changed; preserved: ${destination}`);

    return;
  }

  const temporary = path.join(plan.container, `copy-${index}`);

  if (io.exists(temporary)) fs.unlinkSync(temporary);
  const body = Buffer.from(file.body, 'base64');

  if (file.mode === '120000') fs.symlinkSync(body, temporary);
  else {
    const descriptor = fs.openSync(temporary, 'wx', file.mode === '100755' ? 0o755 : 0o644);

    try { fs.fchmodSync(descriptor, file.mode === '100755' ? 0o755 : 0o644); fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }

  fs.linkSync(temporary, destination);
  fs.unlinkSync(temporary);
  io.sync(path.dirname(destination));
  io.sync(plan.container);
}

function finish(root, plan, fd) {
  if (plan.phase === 'planned') prepare(root, plan, fd);

  verifyTarget(plan);

  for (const [index, file] of plan.files.entries()) writeFile(plan, file, index);

  for (const index of plan.files.keys()) fs.rmSync(path.join(plan.container, `copy-${index}`), { force: true });
  fs.rmSync(path.join(plan.container, 'copy-gitdir'), { force: true });
  const index = path.join(plan.container, 'copy-index');
  fs.rmSync(index, { force: true });
  fs.rmSync(index + '.lock', { force: true });
  git(plan.source, ['read-tree', ...(plan.base ? [plan.base] : ['--empty'])], { env: { ...process.env, GIT_INDEX_FILE: index }, stdio: ['ignore', 'pipe', 'pipe', fd] });
  io.sync(index);
  const destination = git(plan.target, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();

  if (io.exists(destination + '.lock')) throw new Error('Worktree index is locked; retained');

  if (io.exists(destination) && !fs.readFileSync(destination).equals(fs.readFileSync(index))) throw new Error('Worktree index changed; retained');
  fs.renameSync(index, destination);
  io.sync(path.dirname(destination));
  io.sync(plan.container);
  io.syncTree(plan.target);

  if (plan.base) git(plan.common, ['update-ref', '-d', `refs/piop-worktree-creations/${plan.id}`, plan.base]);
  const db = open(root);

  try { db.prepare('DELETE FROM worktree_creations WHERE target=?').run(plan.target); }
  finally { db.close(); }
}

function pending(root) {
  const db = open(root);

  try { return db.prepare('SELECT record_json FROM worktree_creations').all().map(row => JSON.parse(row.record_json)); }
  finally { db.close(); }
}

function validate(root, plan) {
  if (path.dirname(plan.container) !== path.join(root, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(plan.container)) || path.dirname(plan.target) !== plan.container) throw new Error('Invalid worktree creation location');

  if (fs.realpathSync(plan.source) !== plan.source || fs.realpathSync(plan.common) !== plan.common || io.identity(plan.common) !== plan.commonIdentity) throw new Error('Worktree source changed');
}

function recover(root) {
  return locked(root, fd => {
    allocation.recover(root);

    for (const plan of pending(root)) {
      try { validate(root, plan); finish(root, plan, fd); }
      catch (error) { console.error(`Worktree creation retained: ${plan.target}: ${error.message}`); }
    }
  }, true);
}

function create(root, source, branch, revision, copy) {
  return locked(root, fd => {
    allocation.recover(root);
    const previous = pending(root).find(plan => plan.source === source && plan.branch === branch);
    const plan = previous ?? newPlan(root, source, branch, revision, copy);
    validate(root, plan);
    finish(root, plan, fd);

    return plan.target;
  });
}

module.exports = { create, recover };
