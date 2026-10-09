const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const database = require('./session-database.cjs');
const allocation = require('./worktree-allocation.cjs');
const io = require('./session-transactions.cjs');
const fileContents = require('./worktree-files.cjs');
const references = require('./worktree-references.cjs');

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

function newPlan(root, source, branch, revision, copy, existingBranch) {
  git(source, ['check-ref-format', '--branch', branch]);

  if (!existingBranch && git(source, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]).trim()) throw new Error('Git branch already exists');
  const base = revision === '--orphan' ? null : git(source, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const container = path.join(root, 'worktrees', randomUUID().slice(0, 4));
  const target = path.join(container, path.basename(source));

  if (io.exists(container) || database.worktreeMetadata(container) || pending(root).some(plan => plan.container === container)) throw new Error('Worktree container is already reserved');
  let parentBranch = null;

  try { parentBranch = git(source, ['symbolic-ref', '--quiet', 'HEAD']).trim(); } catch { }

  const common = fs.realpathSync(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const plan = { id: randomUUID(), source, common, commonIdentity: io.identity(common), branch, base, parentBranch, container, target, files: [], copy, existingBranch, phase: 'capturing' };
  save(root, plan);

  return plan;
}

function prepareAllocation(root, plan) {
  io.mkdir(path.dirname(plan.container));

  if (!database.worktreeMetadata(plan.container)) allocation.create(plan.container, plan.target, plan.branch, plan.parentBranch);
  const saved = database.worktreeMetadata(plan.container);

  if (saved.creating || saved.containerIdentity !== io.identity(plan.container)) throw new Error('Worktree allocation changed; retained');
  plan.containerIdentity = saved.containerIdentity;
  save(root, plan);
}

function prepare(root, plan, fd) {
  preserveBase(plan, fd);
  prepareAllocation(root, plan);
  createGitWorktree(root, plan, fd);

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

function prepareBranch(root, plan, fd) {
  if (plan.base && !plan.existingBranch && !plan.branchPublished) {
    references.update(plan, 'branch', plan.base, fd);
    plan.branchPublished = true;
    save(root, plan);
  }

}

function createGitWorktree(root, plan, fd) {
  prepareBranch(root, plan, fd);
  repairEmptyWorktree(root, plan);

  if (!io.exists(plan.target)) {
    const existing = git(plan.source, ['for-each-ref', '--format=%(objectname)', `refs/heads/${plan.branch}`]).trim();

    if ((plan.base && existing !== plan.base) || (!plan.base && existing)) throw new Error('Worktree branch changed; retained');
    const args = ['worktree', 'add', '--lock', '--reason', `piop-creation:${plan.id}`, ...(plan.base ? ['--no-checkout'] : ['--orphan', '-b', plan.branch]), '--', plan.target];

    if (plan.base) args.push(plan.branch);
    git(plan.source, args, { stdio: ['ignore', 'pipe', 'pipe', fd] });
    repairEmptyWorktree(root, plan);
  }

}

function verifyEmptyWorktree(target) {
  const info = fs.lstatSync(target);

  if (!info.isDirectory() || process.getuid && info.uid !== process.getuid() || fs.readdirSync(target).some(name => name !== '.git')) throw new Error('Unexpected incomplete worktree contents; retained');
}

function restoreGitPointer(plan, registration) {
  const temporary = path.join(plan.container, 'copy-gitdir');
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);

  try { fs.writeFileSync(fd, `gitdir: ${registration}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }

  fs.renameSync(temporary, path.join(plan.target, '.git'));
  fileContents.sync(plan.target);
  io.sync(plan.container);
}

function repairEmptyWorktree(root, plan) {
  if (!io.exists(plan.target)) return;
  const pointer = path.join(plan.target, '.git');

  const contents = io.exists(pointer) ? fs.readFileSync(pointer, 'utf8') : '';
  const text = contents.trim();

  if (text.startsWith('gitdir: ') && io.exists(path.resolve(plan.target, text.slice(8)))) {
    repairRegistration(root, plan, path.resolve(plan.target, text.slice(8)));

    return;
  }

  if (contents.endsWith('\n')) throw new Error('Worktree pointer changed; retained');

  verifyEmptyWorktree(plan.target);

  if (restoreRegistrationPointer(root, plan, text)) return;

  if (io.exists(pointer)) throw new Error('Incomplete worktree registration is unavailable; retained');
  fs.rmdirSync(plan.target);
  io.sync(plan.container);
}

function restoreRegistrationPointer(root, plan, text) {
  const registrations = path.join(plan.common, 'worktrees');
  const candidates = io.exists(registrations) ? fs.readdirSync(registrations) : [];

  for (const name of candidates) {
    const registration = path.join(registrations, name);
    const pointer = path.join(registration, 'gitdir');

    const backlink = io.exists(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '';

    if ((!backlink || path.resolve(registration, backlink) !== path.join(plan.target, '.git')) && plan.registration?.path !== registration) continue;
    const expected = [`gitdir: ${registration}`, `gitdir: ${path.relative(plan.target, registration)}`];

    if (text && !expected.some(value => value.startsWith(text))) throw new Error('Worktree pointer changed; retained');
    repairRegistration(root, plan, registration);
    restoreGitPointer(plan, registration);

    return true;
  }

  return false;
}

function repairRegistration(root, plan, registration) {
  if (path.dirname(registration) !== path.join(plan.common, 'worktrees') || fs.realpathSync(registration) !== registration) throw new Error('Invalid incomplete worktree registration');
  const identity = io.identity(registration);

  if (plan.registration && (plan.registration.path !== registration || plan.registration.identity !== identity)) throw new Error('Worktree registration was replaced; retained');
  plan.registration = { path: registration, identity };
  save(root, plan);
  completeRegistrationPath(path.join(registration, 'gitdir'), path.join(plan.target, '.git'));
  completeRegistrationPath(path.join(registration, 'commondir'), plan.common);
  repairHead(root, plan, registration);
  const locked = path.join(registration, 'locked');

  if (io.exists(locked)) {
    if (fs.readFileSync(locked, 'utf8').trim() !== `piop-creation:${plan.id}`) throw new Error('Worktree was locked by another operation; retained');
    fs.unlinkSync(locked);
  }

  io.syncTree(registration);
  io.sync(path.dirname(registration));
}

function repairHead(root, plan, registration) {
  const lock = path.join(registration, 'HEAD.lock');
  const seed = path.join(registration, `piop-head-${plan.id}`);

  if (!plan.headLock) {
    if (io.exists(lock)) throw new Error('Worktree HEAD is locked by an unverified operation; retained');
    io.write(seed, '');
    plan.headLock = io.describe(seed);
    save(root, plan);
  }

  if (!io.matches(seed, plan.headLock)) throw new Error('Worktree HEAD lock preparation changed; retained');

  try { fs.linkSync(seed, lock); }
  catch (error) {
    if (error.code !== 'EEXIST' || !io.matches(lock, plan.headLock)) throw new Error('Worktree HEAD is locked by another operation; retained');
  }

  io.sync(registration);

  try { completeRegistrationFile(path.join(registration, 'HEAD'), `ref: refs/heads/${plan.branch}`, false); }
  finally {
    if (io.matches(lock, plan.headLock)) { fs.unlinkSync(lock); io.sync(registration); }
  }
}

function cleanupHeadLock(plan) {
  if (!plan.headLock || !plan.registration) return;
  const seed = path.join(plan.registration.path, `piop-head-${plan.id}`);

  if (!io.matches(seed, plan.headLock)) return;
  fs.unlinkSync(seed);
  io.sync(plan.registration.path);
}

function completeRegistrationPath(file, expected) {
  if (io.exists(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();

    if (value && path.resolve(path.dirname(file), value) === expected) return;
  }

  completeRegistrationFile(file, expected);
}

function completeRegistrationFile(file, expected, allowPrefix = true) {
  if (io.exists(file)) {
    const contents = fs.readFileSync(file, 'utf8');
    const actual = contents.trim();

    if (actual === expected) return;

    if ((!allowPrefix && actual) || contents.endsWith('\n') || !expected.startsWith(actual)) throw new Error(`Worktree registration changed; retained: ${file}`);
  }

  io.write(file, expected + '\n');
}

function preserveBase(plan, fd) {
  if (!plan.base) return;
  const ref = `refs/piop-worktree-creations/${plan.id}`;
  const current = git(plan.common, ['for-each-ref', '--format=%(objectname)', ref]).trim();

  if (current && current !== plan.base) throw new Error('Worktree creation reference changed');

  references.update(plan, 'creations', plan.base, fd);
}

function verifyTarget(plan) {
  if (io.identity(plan.container) !== plan.containerIdentity || io.identity(plan.target) !== plan.targetIdentity || fs.realpathSync(plan.target) !== plan.target) throw new Error('Worktree directory changed; retained');
  const common = fs.realpathSync(git(plan.target, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const branch = git(plan.target, ['symbolic-ref', 'HEAD']).trim();
  const tip = git(plan.common, ['for-each-ref', '--format=%(objectname)', `refs/heads/${plan.branch}`]).trim();

  if (common !== plan.common || branch !== `refs/heads/${plan.branch}` || tip !== (plan.base ?? '')) throw new Error('Worktree Git ownership changed; retained');
}

function prepareIndex(root, plan, index, lock) {
  if (plan.indexProof) return;
  fs.rmSync(index, { force: true });
  fs.rmSync(index + '.lock', { force: true });
  git(plan.source, ['read-tree', ...(plan.base ? [plan.base] : ['--empty'])], { env: { ...process.env, GIT_INDEX_FILE: index }, stdio: ['ignore', 'pipe', 'pipe', lock] });
  io.sync(index);
  io.sync(path.dirname(index));
  plan.indexProof = io.describe(index);
  save(root, plan);
}

function publishIndex(root, plan, lock) {
  const destination = git(plan.target, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const index = path.join(path.dirname(destination), `piop-copy-index-${plan.id}`);
  const gitLock = destination + '.lock';

  if (plan.indexPublished) {
    removeIndexLock(gitLock, plan.indexProof);

    if (io.matches(index, plan.indexProof)) { fs.unlinkSync(index); io.sync(path.dirname(index)); }

    return;
  }

  if (!io.exists(index) && plan.indexProof && io.matches(destination, plan.indexProof)) {
    plan.indexPublished = true;
    save(root, plan);
    removeIndexLock(gitLock, plan.indexProof);

    return;
  }

  prepareIndex(root, plan, index, lock);

  if (!io.matches(index, plan.indexProof)) throw new Error('Prepared worktree index changed; retained');
  acquireIndexLock(index, gitLock, plan.indexProof);

  try {
    if (io.exists(destination) && !fs.readFileSync(destination).equals(fs.readFileSync(index))) throw new Error('Worktree index changed; retained');
    fs.renameSync(gitLock, destination);
    io.sync(path.dirname(destination));
    plan.indexPublished = true;
    save(root, plan);
    fs.unlinkSync(index);
    io.sync(path.dirname(index));
  } finally {
    removeIndexLock(gitLock, plan.indexProof);
  }
}

function removeIndexLock(lock, proof) {
  if (io.matches(lock, proof)) { fs.unlinkSync(lock); io.sync(path.dirname(lock)); }
}

function acquireIndexLock(index, lock, proof) {
  try { fs.linkSync(index, lock); }
  catch (error) {
    if (error.code !== 'EEXIST' || !io.matches(lock, proof)) throw new Error('Worktree index is locked by another operation; retained');
  }

  io.sync(path.dirname(lock));
}

function finish(root, plan, fd) {
  references.releaseLocks(plan);

  if (plan.phase === 'capturing') {
    preserveBase(plan, fd);
    prepareAllocation(root, plan);
    plan.files = fileContents.capture(plan, fd);
    plan.phase = 'planned';
    save(root, plan);
  }

  if (plan.phase === 'planned') prepare(root, plan, fd);

  if (plan.phase !== 'cleanup') {
    publishFiles(root, plan, fd);
    plan.phase = 'cleanup';
    save(root, plan);
  }

  if (plan.base) references.update(plan, 'creations', null, fd);
  references.update(plan, 'content', null, fd);
  references.releaseBranch(plan);
  const db = open(root);

  try { db.prepare('DELETE FROM worktree_creations WHERE target=?').run(plan.target); }
  finally { db.close(); }
}

function publishFiles(root, plan, fd) {
  verifyTarget(plan);

  for (const [index, file] of plan.files.entries()) fileContents.write(plan, file, index, fd);

  for (const index of plan.files.keys()) fs.rmSync(path.join(plan.container, `copy-${index}`), { force: true });
  fs.rmSync(path.join(plan.container, 'copy-gitdir'), { force: true });
  publishIndex(root, plan, fd);
  fileContents.sync(plan.target);
  cleanupHeadLock(plan);

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

function create(root, source, branch, revision, copy, existingBranch = false) {
  return locked(root, fd => {
    allocation.recover(root);
    const previous = pending(root).find(plan => plan.source === source && plan.branch === branch);

    if (previous) {
      const base = revision === '--orphan' ? null : git(source, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();

      if (previous.base !== base || previous.copy !== copy || previous.existingBranch !== existingBranch) throw new Error('This name has unfinished creation from different input; choose another name or resume the original request');
    }

    const plan = previous ?? newPlan(root, source, branch, revision, copy, existingBranch);
    validate(root, plan);
    finish(root, plan, fd);

    return plan.target;
  });
}

function checkout(root, source, branch) {
  return locked(root, fd => {
    allocation.recover(root);
    const common = fs.realpathSync(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    const previous = pending(root).find(plan => plan.common === common && plan.branch === branch);

    if (previous) {
      validate(root, previous);
      finish(root, previous, fd);

      return previous.target;
    }

    const listed = git(source, ['worktree', 'list', '--porcelain', '-z']);
    const existing = listed.split('\0\0').find(record => record.split('\0').includes(`branch refs/heads/${branch}`));

    if (existing) {
      const target = existing.split('\0').find(field => field.startsWith('worktree '))?.slice(9);

      if (!target || !io.exists(target)) throw new Error('The branch worktree is unavailable');

      return target;
    }

    const plan = newPlan(root, source, branch, `refs/heads/${branch}`, false, true);
    validate(root, plan);
    finish(root, plan, fd);

    return plan.target;
  });
}

module.exports = { create, recover, checkout };
