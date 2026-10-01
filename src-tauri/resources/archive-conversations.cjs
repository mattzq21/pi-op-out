const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const request = JSON.parse(process.argv[1]);
const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));
const sessions = fs.realpathSync(path.join(root, 'sessions'));
const archive = path.join(root, 'archived');
const storedDirectories = path.join(root, 'archived-tmp');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';
function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
  }).trim();
}
function readSession(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
  const header = entries[0];
  if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id || !path.isAbsolute(header.cwd ?? '')) throw new Error(`Invalid session: ${file}`);
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
  const canonical = fs.realpathSync(cwd);
  let top;
  try { top = fs.realpathSync(git(canonical, ['rev-parse', '--show-toplevel'])); }
  catch (error) {
    if (!String(error.stderr).includes('not a git repository')) throw error;
    if (inside(canonical, root)) throw new Error('The session directory contains piop storage and cannot be moved');
    return { path: canonical, kind: 'directory' };
  }
  const common = fs.realpathSync(git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const own = fs.realpathSync(git(top, ['rev-parse', '--absolute-git-dir']));
  if (own === common) return { path: top, kind: 'main' };
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
  group.metadata = path.join(transaction, `${randomUUID()}.git`);
  fs.cpSync(group.own, group.metadata, { recursive: true, verbatimSymlinks: true });
  git(group.path, ['read-tree', '--empty'], { env });
  git(group.path, ['add', '--all', '--force', '--', '.'], { env });
  const tree = git(group.path, ['write-tree'], { env });
  group.commit = git(group.path, ['commit-tree', tree, '-p', head], { env, input: 'Archive conversation working directory\n' });
  fs.unlinkSync(index);
  group.refs = group.records.map(({ header }) => `refs/pi-session-snapshots/chats/${safeId(header.id)}/archive/${randomUUID()}`);
  git(group.common, ['update-ref', '--stdin'], { input: ['start', ...group.refs.map((ref) => `create ${ref} ${group.commit}`), 'prepare', 'commit', ''].join('\n') });
}
function rewriteCheckpoints(record, group) {
  const belongs = (cwd) => {
    try { return fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === group.common; }
    catch { return false; }
  };
  for (const entry of record.entries) {
    if (entry.type !== 'custom' || !entry.data || entry.data.unavailable) continue;
    if (entry.customType === 'pi-project-files-watch-snapshot' && belongs(entry.data.repositoryRoot)) entry.data.repositoryRoot = group.common;
    if (entry.customType === 'pi-project-prompt-checkpoint' && belongs(entry.data.repositoryRoot ?? record.header.checkpointRepositoryRoot ?? record.header.cwd)) entry.data.repositoryRoot = group.common;
  }
}
function rollback(groups, records) {
  const errors = [];
  for (const group of [...groups].reverse()) {
    try {
      if (!group.moved) continue;
      if (group.kind === 'directory') fs.renameSync(group.storedPath, group.path);
      else if (!group.removed) git(group.common, ['worktree', 'move', '--force', '--force', group.storedPath, group.path]);
      else {
        if (group.branchDeleted) git(group.common, ['update-ref', '--stdin'], { input: `create ${group.branchRef} ${group.head}\n` });
        git(group.common, ['worktree', 'add', '--detach', group.path, group.head]);
        git(group.path, ['restore', '--source', group.commit, '--worktree', '--', '.']);
        const own = git(group.path, ['rev-parse', '--absolute-git-dir']);
        for (const entry of fs.readdirSync(group.metadata)) {
          if (entry === 'gitdir' || entry === 'commondir') continue;
          fs.cpSync(path.join(group.metadata, entry), path.join(own, entry), { recursive: true, verbatimSymlinks: true });
        }
      }
    } catch (error) { errors.push(`Recovery for ${group.path}: ${error.message}`); }
  }
  for (const record of [...records].reverse()) {
    try {
      for (const move of [...record.moves].reverse()) fs.renameSync(move.to, move.from);
      if (record.backup) fs.copyFileSync(record.backup, record.file);
    } catch (error) { errors.push(`Recovery for ${record.file}: ${error.message}`); }
  }
  return errors;
}
function main() {
  const selected = new Set(request.paths.map((file) => fs.realpathSync(file)));
  const records = [...selected].map((file) => {
    if (!inside(sessions, file) || !file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) throw new Error('Only active piop sessions can be archived');
    return { ...readSession(file), moves: [] };
  });
  const byDirectory = new Map();
  for (const record of records) {
    const location = locate(record.header.cwd);
    if (!byDirectory.has(location.path)) byDirectory.set(location.path, { ...location, records: [] });
    byDirectory.get(location.path).records.push(record);
  }
  const groups = [...byDirectory.values()];
  const removable = groups.filter((group) => group.kind !== 'main');
  for (const group of removable) {
    if (groups.some((other) => other !== group && inside(group.path, other.path))) throw new Error('Overlapping session directories cannot be archived together');
    if (records.some((record) => inside(group.path, record.file))) throw new Error('The working directory contains conversation storage and cannot be moved');
  }
  const assertUnused = (cwd) => {
    let canonical;
    try { canonical = fs.realpathSync(cwd); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (removable.some((group) => inside(group.path, canonical))) throw new Error(`Another chat or terminal still uses ${cwd}`);
  };
  if (removable.length) {
    walkSessions(sessions, (file) => { if (!selected.has(file)) assertUnused(readSession(file).header.cwd); });
    request.terminals.forEach(assertUnused);
  }
  if (request.inspect) {
    process.stdout.write(JSON.stringify(groups.filter((group) => group.kind === 'git').map(({ path, source }) => ({ path, source }))));
    return;
  }
  fs.mkdirSync(archive, { recursive: true });
  if (removable.length) fs.mkdirSync(storedDirectories, { recursive: true });
  const transaction = fs.mkdtempSync(path.join(root, 'archive-transaction-'));
  try {
    for (const group of groups) {
      group.storedPath = path.join(storedDirectories, randomUUID());
      if (group.kind === 'git') snapshot(group, transaction);
      for (const [index, record] of group.records.entries()) {
        record.backup = path.join(transaction, `${randomUUID()}.jsonl`);
        fs.copyFileSync(record.file, record.backup, fs.constants.COPYFILE_EXCL);
        if (group.kind === 'git') rewriteCheckpoints(record, group);
        if (group.kind === 'main') delete record.header.worktreeRestore;
        else record.header.worktreeRestore = {
          kind: group.kind, path: group.path, conversationPath: fs.realpathSync(record.header.cwd),
          ...(group.kind === 'git' ? { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index], branch: group.branchRef?.slice('refs/heads/'.length) } : { storedPath: group.storedPath }),
        };
        if (group.kind === 'git') record.entries.push({ id: randomUUID(), parentId: record.entries.at(-1)?.id, type: 'custom', customType: 'pi-project-files-watch-snapshot', data: { repositoryRoot: group.common, commit: group.commit, ref: group.refs[index] } });
        record.destination = path.join(archive, `${randomUUID()}-${path.basename(record.file)}`);
        const prepared = path.join(transaction, `${randomUUID()}.prepared`);
        fs.writeFileSync(prepared, record.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: fs.statSync(record.file).mode & 0o777 });
        record.prepared = prepared;
      }
    }
    fs.writeFileSync(path.join(transaction, 'recovery.json'), JSON.stringify({ groups, records }), { flag: 'wx', mode: 0o600 });
    for (const group of removable) {
      if (group.kind === 'directory') fs.renameSync(group.path, group.storedPath);
      else git(group.common, ['worktree', 'move', '--force', '--force', group.path, group.storedPath]);
      group.moved = true;
    }
    for (const record of records) {
      fs.renameSync(record.prepared, record.file);
      for (const [from, to] of [[record.file.replace(/\.jsonl$/, '.snapshots'), record.destination.replace(/\.jsonl$/, '.snapshots')], [record.file.replace(/\.jsonl$/, '.diffs.json'), record.destination.replace(/\.jsonl$/, '.diffs.json')], [`${record.file}.loop-detection.json`, `${record.destination}.loop-detection.json`], [record.file, record.destination]]) {
        try { fs.renameSync(from, to); record.moves.push({ from, to }); }
        catch (error) { if (error.code !== 'ENOENT' || from === record.file) throw error; }
      }
    }
    for (const group of groups.filter((candidate) => candidate.kind === 'git')) {
      git(group.common, ['worktree', 'remove', '--force', '--force', group.storedPath]);
      group.removed = true;
      if (group.branchRef) {
        const worktrees = git(group.common, ['worktree', 'list', '--porcelain', '-z']).split('\0');
        if (worktrees.includes(`branch ${group.branchRef}`)) throw new Error('The branch is still checked out in another worktree');
        git(group.common, ['update-ref', '-d', group.branchRef, group.head]);
        group.branchDeleted = true;
      }
    }
  } catch (error) {
    const failures = rollback(groups, records);
    throw new Error(`${error.message}\nArchiving failed.${failures.length ? '\n' + failures.join('\n') : ' Conversations remain active.'}\nRecovery data: ${transaction}`);
  }
  try { fs.rmSync(transaction, { recursive: true, force: true }); }
  catch (error) { console.error(`Archived successfully; temporary recovery files remain at ${transaction}: ${error.message}`); }
}
try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
