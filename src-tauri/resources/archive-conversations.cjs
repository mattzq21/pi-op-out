const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');
const { archiveGroup, cleanup, prepare } = require('./archive-transaction.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { runWithStorageLock } = require('./storage-lock.cjs');

const request = process.argv[1] === '--recover' ? null : JSON.parse(process.argv[1]);

const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

const sessions = fs.realpathSync(path.join(root, 'sessions'));

const archive = path.join(root, 'archived');

const storedDirectories = path.join(root, 'archived-tmp');

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

const safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', 3, 4], ...options,
  }).trim();
}

function readSession(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
  const header = entries[0];

  if (!validSessionHeader(header)) throw new Error(`Invalid session: ${file}`);

  return { file, entries, header };
}

function walkSessions(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) walkSessions(file, visit);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) visit(file);
  }
}

function locate(cwd) {
  let canonical;

  try { canonical = fs.realpathSync(cwd); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path: path.resolve(cwd), kind: 'missing' };
    throw error;
  }

  let top;

  try { top = fs.realpathSync(git(canonical, ['rev-parse', '--show-toplevel'])); }
  catch (error) {
    if (!String(error.stderr).includes('not a git repository')) throw error;

    if (inside(canonical, root)) throw new Error('The session directory contains piop storage and cannot be moved');

    return { path: canonical, kind: 'directory' };
  }

  return locateWorktree(top);
}

function locateWorktree(top) {
  const common = fs.realpathSync(git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const own = fs.realpathSync(git(top, ['rev-parse', '--absolute-git-dir']));

  if (own === common) return { path: top, kind: 'main', common, own };

  if (inside(top, root) || inside(top, common)) throw new Error('The worktree contains storage needed for recovery');
  const source = git(common, ['worktree', 'list', '--porcelain', '-z']).split('\0').find((entry) => entry.startsWith('worktree '))?.slice(9);

  if (!source) throw new Error('Could not locate the parent checkout');

  return { path: top, kind: 'git', common, own, source };
}

function rejectNestedRepositories(directory, top = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') {
      if (directory !== top) throw new Error(`Cannot snapshot an embedded repository: ${directory}`);
      continue;
    }

    if (entry.isDirectory()) rejectNestedRepositories(path.join(directory, entry.name), top);
    else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Cannot snapshot this filesystem entry: ${path.join(directory, entry.name)}`);
  }
}

function snapshot(group, transaction) {
  rejectNestedRepositories(group.path);
  const index = path.join(transaction, `${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'piop', GIT_AUTHOR_EMAIL: 'piop@localhost', GIT_COMMITTER_NAME: 'piop', GIT_COMMITTER_EMAIL: 'piop@localhost' };
  const head = git(group.path, ['rev-parse', '--verify', 'HEAD']);
  group.head = head;

  try { group.branchRef = git(group.path, ['symbolic-ref', '--quiet', 'HEAD']); }
  catch (error) { if (error.status !== 1) throw error; }

  if (group.branchRef && !group.branchRef.startsWith('refs/heads/')) throw new Error('Invalid worktree branch');

  fs.copyFileSync(path.join(group.own, 'index'), index);
  const tree = git(group.path, ['write-tree'], { env });
  group.commit = git(group.path, ['commit-tree', tree, '-p', head], { env, input: 'Archive conversation working directory\n' });
  fs.unlinkSync(index);
  group.refs = group.records.map(({ header }) => `refs/pi-session-snapshots/chats/${safeId(header.id)}/archive/${randomUUID()}`);
}

function rewriteCheckpoints(record, group) {
  const belongs = (cwd) => {
    try { return fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === group.common; }
    catch { return false; }
  };

  function rewrite(entry) {
    if (entry.type !== 'custom' || !entry.data || entry.data.unavailable) return;

    if (entry.customType === 'pi-project-files-watch-snapshot' && belongs(entry.data.repositoryRoot)) entry.data.repositoryRoot = group.common;

    if (entry.customType === 'pi-project-prompt-checkpoint' && belongs(entry.data.repositoryRoot ?? record.header.checkpointRepositoryRoot ?? record.header.cwd)) entry.data.repositoryRoot = group.common;
  }

  record.entries.forEach(rewrite);
}

function preserveSharedDirectories(groups, selected) {
  walkSessions(sessions, (file) => {
    if (selected.has(fs.realpathSync(file))) return;
    const cwd = readSession(file).header.cwd;
    let canonical;

    try { canonical = fs.realpathSync(cwd); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }

    for (const group of groups) {
      if ((group.kind === 'git' || group.kind === 'directory') && inside(group.path, canonical)) group.shared = true;
    }
  });
}


function recordRecovery(record, group, index) {
  const gitSnapshot = group.kind === 'git' || group.kind === 'main';

  if (gitSnapshot) rewriteCheckpoints(record, group);

  if (group.kind !== 'missing') record.header.worktreeRestore = {
    kind: gitSnapshot ? 'git' : group.kind, path: group.path, conversationPath: fs.realpathSync(record.header.cwd),
    ...(gitSnapshot ? { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index], branch: group.branchRef?.slice('refs/heads/'.length) } : { storedPath: group.storedPath, persistent: true }),
  };

  if (gitSnapshot) record.entries.push({ id: randomUUID(), parentId: record.entries.at(-1)?.id, type: 'custom', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index] } });
}

function prepareRecord(record, group, index, transaction) {
  record.backup = path.join(transaction, `${randomUUID()}.jsonl`);
  record.header.archiveSessionPath = fs.realpathSync(record.file);
  record.previousDirectory = record.header.worktreeRestore?.kind === 'directory' ? record.header.worktreeRestore.storedPath : undefined;
  recordRecovery(record, group, index);
  record.destination = path.join(archive, `${randomUUID()}-${path.basename(record.file)}`);
  const prepared = path.join(transaction, `${randomUUID()}.prepared`);
  fs.writeFileSync(prepared, record.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: fs.statSync(record.file).mode & 0o777 });
  record.prepared = prepared;
}

function prepareArchive() {
  const selected = new Set(request.paths.map((file) => fs.realpathSync(file)));

  const records = [...selected].map((file) => {
    if (!inside(sessions, file) || !file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) throw new Error('Only active piop sessions can be archived');

    return readSession(file);
  });

  const byDirectory = new Map();

  for (const record of records) {
    const location = locate(record.header.cwd);

    if (location.kind === 'missing' && !record.header.worktreeRestore) throw new Error(`The working directory is missing and has no recovery snapshot: ${record.header.cwd}`);

    if (!byDirectory.has(location.path)) byDirectory.set(location.path, { ...location, records: [] });
    byDirectory.get(location.path).records.push(record);
  }

  const groups = [...byDirectory.values()];
  preserveSharedDirectories(groups, selected);
  const removable = groups.filter((group) => !group.shared && (group.kind === 'git' || group.kind === 'directory'));

  for (const group of removable) {
    if (groups.some((other) => other !== group && inside(group.path, other.path))) throw new Error('Overlapping session directories cannot be archived together');

    if (records.some((record) => inside(group.path, record.file))) throw new Error('The working directory contains conversation storage and cannot be moved');
  }

  const assertUnused = (cwd) => {
    let canonical;

    try { canonical = fs.realpathSync(cwd); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }

    if (removable.some((group) => inside(group.path, canonical))) throw new Error(`Another chat or terminal still uses ${cwd}`);
  };

  if (removable.length) {
    request.terminals.forEach(assertUnused);
  }

  return { records, groups, removable };
}

function prepareGroups(groups, transaction) {
  for (const group of groups) {
    group.storedPath = path.join(storedDirectories, randomUUID());

    if (group.kind === 'git' || group.kind === 'main') snapshot(group, transaction);

    if (group.kind === 'directory') {
      group.retiredPath = path.join(transaction, `${randomUUID()}.directory`);
      group.preparedDirectory = path.join(transaction, `${randomUUID()}.snapshot`);
      fs.cpSync(group.path, group.preparedDirectory, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    }

    for (const [index, record] of group.records.entries()) {
      prepareRecord(record, group, index, transaction);
    }
  }

}

function main() {
  recoverStorage(root);

  if (!request) return;
  const { records, groups, removable } = prepareArchive();

  if (request.inspect) {
    process.stdout.write(JSON.stringify(removable.flatMap((group) => group.kind === 'git' ? [{ path: group.path, source: group.source }] : [])));

    return;
  }

  fs.mkdirSync(archive, { recursive: true });

  if (groups.some(group => group.kind === 'directory') || removable.length) fs.mkdirSync(storedDirectories, { recursive: true });
  const transaction = fs.mkdtempSync(path.join(root, 'archive-transaction-'));
  prepare(transaction);

  try {
    prepareGroups(groups, transaction);
  } catch (error) {
    cleanup(transaction);
    throw error;
  }

  archiveGroup(root, transaction, groups, records, removable);
}

runWithStorageLock(root, main);
