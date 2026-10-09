const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');
const transactions = require('./session-transactions.cjs');
const archiveTransaction = require('./archive-transaction.cjs');
const goalAssets = require('./session-broker/goal-assets.cjs');
const shared = require('./archive-resource-transactions.cjs');
const checkpoints = require('./archive-checkpoints.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { lockStorage } = require('./restore-transaction.cjs');

const request = process.argv[1] === '--recover' ? null : JSON.parse(process.argv[1]);

const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

const sessions = fs.realpathSync(path.join(root, 'sessions'));

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', 3, 4, 5, 6], ...options,
  }).trim();
}

function readSession(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
  const header = entries[0];

  if (!validSessionHeader(header)) throw new Error(`Invalid session: ${file}`);

  return { file, entries, header };
}

function walkSessions(directory, visit) {
  for (const file of require('./session-database.cjs').paths(root)) {
    if (!inside(directory, file)) continue;
    let metadata;

    try { metadata = fs.lstatSync(file); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }

    if (metadata.isFile()) visit(file);
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

function presentSkippedPaths(directory, entries) {
  return entries.flatMap((entry) => {
    if (entry[0].toUpperCase() !== 'S') return [];
    const file = entry.slice(2);

    try { fs.lstatSync(path.join(directory, file));

    return [file]; }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
  });
}

function captureWorkingFiles(group, index, env) {
  fs.copyFileSync(path.join(group.own, 'index'), index);
  const entries = git(group.path, ['ls-files', '-v', '-z'], { env }).split('\0').filter(Boolean);
  const paths = entries.map((entry) => entry.slice(2));
  const presentSkipped = presentSkippedPaths(group.path, entries);

  if (paths.length) git(group.path, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], { env, input: paths.join('\0') + '\0' });

  if (presentSkipped.length) git(group.path, ['update-index', '--no-skip-worktree', '-z', '--stdin'], { env, input: presentSkipped.join('\0') + '\0' });
  git(group.path, ['add', '--all', '--sparse', '--', '.'], { env });
}

function backupWorktree(group, transaction) {
  fs.cpSync(group.path, group.dataBackup, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true });

  if (!transactions.matches(group.path, group.identity) || !transactions.sameContents(group.dataBackup, group.identity)) throw new Error('The working directory changed while its archive recovery copy was created');
  transactions.syncTree(group.dataBackup);
  group.dataBackupIdentity = transactions.describe(group.dataBackup);
  fs.cpSync(group.own, group.metadata, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
  transactions.syncTree(group.metadata);
  group.metadataIdentity = transactions.describe(group.metadata);
  archiveTransaction.save(transaction);
}

function snapshot(group, transaction) {
  rejectNestedRepositories(group.path);
  const index = group.index;
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'piop', GIT_AUTHOR_EMAIL: 'piop@localhost', GIT_COMMITTER_NAME: 'piop', GIT_COMMITTER_EMAIL: 'piop@localhost' };
  const head = git(group.path, ['rev-parse', '--verify', 'HEAD']);
  group.head = head;

  try { group.branchRef = git(group.path, ['symbolic-ref', '--quiet', 'HEAD']); }
  catch (error) { if (error.status !== 1) throw error; }

  if (group.branchRef && !group.branchRef.startsWith('refs/heads/')) throw new Error('Invalid worktree branch');
  archiveTransaction.save(transaction);

  if (group.kind === 'git') backupWorktree(group, transaction);
  captureWorkingFiles(group, index, env);
  const tree = git(group.path, ['write-tree'], { env });
  group.commit = git(group.path, ['commit-tree', tree, '-p', head], { env, input: 'Archive conversation working directory\n' });
  fs.unlinkSync(index);
  archiveTransaction.save(transaction);
  git(group.common, ['update-ref', '--stdin'], { input: ['start', ...group.refs.map((ref) => `create ${ref} ${group.commit}`), 'prepare', 'commit', ''].join('\n') });
  transactions.syncTree(group.common);
}

function preserveSharedDirectories(groups, selected) {
  walkSessions(sessions, (file) => {
    if (selected.has(fs.realpathSync(file))) return;
    const header = require('./transcript-references.cjs').read(root, file)[0];

    if (!validSessionHeader(header)) throw new Error(`Invalid session: ${file}`);
    const cwd = header.cwd;
    let canonical;

    try { canonical = fs.realpathSync(cwd); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }

    for (const group of groups) {
      if ((group.kind === 'git' || group.kind === 'directory') && inside(group.path, canonical)) { group.resourceKind = group.kind; group.kind = 'shared'; }
    }
  });
}


function backupRecord(record, transaction) {
  fs.copyFileSync(record.file, record.backup, fs.constants.COPYFILE_EXCL);
  transactions.syncTree(record.backup);
  record.backupIdentity = transactions.describe(record.backup);

  if (!transactions.matches(record.file, record.original) || !transactions.sameContents(record.backup, record.original)) throw new Error('The conversation changed while its archive backup was created');
  archiveTransaction.save(transaction);
}

function prepareRecord(record, group, index, transaction) {
  backupRecord(record, transaction);

  record.header.archiveSessionPath = fs.realpathSync(record.file);

  if (['git', 'main'].includes(group.kind)) checkpoints.remapSelected(record, group);

  if (group.kind === 'shared') delete record.header.worktreeRestore;
  else if (group.kind !== 'missing') record.header.worktreeRestore = {
    kind: group.kind === 'main' ? 'git' : group.kind, path: group.path, conversationPath: fs.realpathSync(record.header.cwd),
    ...(['git', 'main'].includes(group.kind) ? { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index], branch: group.branchRef?.slice('refs/heads/'.length) } : { storedPath: group.storedPath }),
  };

  if (['git', 'main'].includes(group.kind)) record.entries.push({ id: randomUUID(), parentId: record.entries.at(-1)?.id, type: 'custom', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index] } });
  shared.archiveHeader(transaction, group, record);
  record.header.goalAssets = goalAssets.retainHistory(root, record.entries, record.header.id, record.destination);
  fs.writeFileSync(record.prepared, record.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: record.mode });
  transactions.syncTree(record.prepared);
  record.preparedIdentity = transactions.describe(record.prepared);
  archiveTransaction.save(transaction);
}

function prepareArchive() {
  const selected = new Set(request.paths.map((file) => fs.realpathSync(file)));

  const records = [...selected].map((file) => {
    if (!inside(sessions, file) || !file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) throw new Error('Only active piop sessions can be archived');

    return { ...readSession(file), moves: [] };
  });

  const byDirectory = new Map();

  for (const record of records) {
    const location = locate(record.header.cwd);

    if (location.kind === 'missing' && !record.header.worktreeRestore && !record.header.archiveResourceId) throw new Error(`The working directory is missing and has no recovery snapshot: ${record.header.cwd}`);

    if (!byDirectory.has(location.path)) byDirectory.set(location.path, { ...location, records: [] });
    byDirectory.get(location.path).records.push(record);
  }

  const groups = [...byDirectory.values()];
  preserveSharedDirectories(groups, selected);
  const removable = groups.filter((group) => group.kind === 'git' || group.kind === 'directory');

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
    if (['git', 'main'].includes(group.kind)) snapshot(group, transaction);
    shared.sealArchive(transaction, group);
    archiveTransaction.save(transaction);

    for (const [index, record] of group.records.entries()) {
      prepareRecord(record, group, index, transaction);
    }
  }

}

function attachRecords(transaction) {
  for (const record of transaction.records) {
    const { entries, header } = readSession(record.file);

    if (header.id !== record.sessionId) throw new Error('Archive conversation identity changed');
    Object.defineProperties(record, { entries: { value: entries }, header: { value: header } });
  }

  for (const [index, group] of transaction.groups.entries()) Object.defineProperty(group, 'records', { value: transaction.records.filter(record => record.group === index) });
}

function main() {
  transactions.recover(root);
  recoverStorage(root);

  if (!request) return;

  if (request.transaction) return executeArchive(archiveTransaction.load(root, request.transaction));
  const { records, groups } = prepareArchive();

  if (request.inspect) {
    process.stdout.write(JSON.stringify(groups.flatMap((group) => group.kind === 'git' ? [{ path: group.path, source: group.source }] : [])));

    return;
  }

  const transaction = archiveTransaction.plan(root, groups, records);

  if (request.action === 'plan') {
    process.stdout.write(JSON.stringify({ transaction: transaction.id, worktrees: transaction.groups.filter(group => group.kind === 'git').map(group => ({ path: group.path, source: group.source })) }));

    return;
  }

  return executeArchive(transaction);
}

function executeArchive(transaction) {
  Object.defineProperty(transaction, 'borrowedOwnerIds', { value: transaction.records.map(record => record.sessionId) });

  return checkpoints.preserve(transaction, transaction.borrowedOwnerIds, () => executeArchiveLocked(transaction));
}

function executeArchiveLocked(transaction) {
  attachRecords(transaction);
  archiveTransaction.begin(transaction);

  try {
    prepareGroups(transaction.groups, transaction);
    shared.planPeers(transaction, archiveTransaction.save);
    shared.preparePeers(transaction, archiveTransaction.save);
    shared.assertArchiveOwners(transaction);

    for (const group of transaction.groups.filter(group => group.identity)) archiveTransaction.moveGroup(transaction, group);

    for (const record of transaction.records) archiveTransaction.publishRecord(transaction, record);
    shared.publishPeers(transaction);

    archiveTransaction.commit(transaction);
  } catch (error) {
    if (transaction.state === 'committed') throw new Error(`${error.message}\nArchive commit evidence was retained at ${transaction.container}; recovery will finish it.`);

    try { archiveTransaction.rollback(transaction); }
    catch (failure) { throw new Error(`${error.message}\nArchive recovery is pending: ${failure.message}\nRecovery data: ${transaction.container}`); }

    throw new Error(`${error.message}\nArchiving was rolled back. Recovery data: ${transaction.container}`);
  }

  try { archiveTransaction.finish(transaction); }
  catch (error) { console.error(`Archive committed; cleanup will retry. Recovery data: ${transaction.container}: ${error.message}`); }
}

try { if (lockStorage(root)) main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
