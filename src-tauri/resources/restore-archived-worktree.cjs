const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const file = fs.realpathSync(process.argv[1]);
const archive = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'archived'));
if (!file.startsWith(archive + path.sep) || !file.endsWith('.jsonl')) throw new Error('Only archived conversations can restore worktrees');
const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
const header = entries[0];
const saved = header?.worktreeRestore;
const sessions = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const destination = path.join(fs.realpathSync(sessions), path.basename(file));
const sessionMoves = [
  [file.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.snapshots')],
  [file.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json')],
  [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
  [file, destination],
];
for (const [, target] of sessionMoves) {
  try { fs.lstatSync(target); throw new Error(`The active session destination already exists: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function restoreSession(undoDirectory) {
  const moved = [];
  try {
    for (const [source, target] of sessionMoves) {
      try { fs.renameSync(source, target); moved.push([source, target]); }
      catch (error) { if (error.code !== 'ENOENT' || source === file) throw error; }
    }
  } catch (error) {
    const failures = [];
    for (const [source, target] of moved.reverse()) {
      try { fs.renameSync(target, source); } catch (failure) { failures.push(failure.message); }
    }
    try { undoDirectory(); } catch (failure) { failures.push(failure.message); }
    throw new Error([error.message, ...failures].join('\n'));
  }
}
if (header?.type === 'session' && !saved && path.isAbsolute(header.cwd ?? '')) {
  const inspect = (args) => execFileSync('git', ['-C', header.cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const own = fs.realpathSync(inspect(['rev-parse', '--absolute-git-dir']));
  const common = fs.realpathSync(inspect(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (own !== common) throw new Error('No saved worktree checkpoint is available');
  restoreSession(() => {});
  process.stdout.write(JSON.stringify({ path: header.cwd, branch: null, sessionPath: destination }));
  process.exit(0);
}
if (header?.type === 'session' && saved?.kind === 'directory') {
  const storage = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'archived-tmp'));
  const stored = fs.realpathSync(saved.storedPath);
  if (path.dirname(stored) !== storage || !path.isAbsolute(saved.path ?? '') || !fs.lstatSync(stored).isDirectory()) throw new Error('Invalid archived directory');
  try { fs.lstatSync(saved.path); throw new Error('The original directory already exists; it will not be overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(saved.path), { recursive: true });
  fs.renameSync(stored, saved.path);
  restoreSession(() => fs.renameSync(saved.path, stored));
  process.stdout.write(JSON.stringify({ path: saved.path, branch: null, sessionPath: destination }));
  process.exit(0);
}
if (header?.type !== 'session' || !saved || !path.isAbsolute(saved.path ?? '') || !path.isAbsolute(saved.repositoryRoot ?? '')
  || typeof saved.ref !== 'string' || !saved.ref.startsWith('refs/pi-session-snapshots/')
  || !/^[a-f0-9]{40,64}$/.test(saved.commit ?? '')) throw new Error('No saved worktree checkpoint is available');
const owner = typeof header.id === 'string' ? header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session' : undefined;
if (!owner || !saved.ref.startsWith(`refs/pi-session-snapshots/chats/${owner}/`)) throw new Error('The restoration checkpoint is not owned by this archive');
const conversationPath = saved.conversationPath ?? header.cwd;
if (typeof conversationPath !== 'string' || !path.isAbsolute(conversationPath)) throw new Error('Invalid archived conversation location');
const relative = path.relative(saved.path, conversationPath);
if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid archived worktree location');
const git = (args) => execFileSync('git', ['-C', saved.repositoryRoot, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (git(['rev-parse', '--verify', saved.ref]) !== saved.commit) throw new Error('The recovery checkpoint is missing or has changed');
const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
let cursor = entries.at(-1);
let response;
const visited = new Set();
while (cursor && !visited.has(cursor.id)) {
  visited.add(cursor.id);
  if (cursor.type === 'message' && cursor.message?.role === 'assistant') { response = cursor; break; }
  cursor = byId.get(cursor.parentId);
}
const snapshot = entries.findLast((entry) => entry.type === 'custom' && entry.customType === 'pi-project-files-watch-snapshot'
  && (saved.kind === 'git' ? entry.data?.ref === saved.ref : response && entry.data?.responseEntryIds?.includes(response.id)));
if (!snapshot || snapshot.data.unavailable || snapshot.data.ref !== saved.ref || snapshot.data.commit !== saved.commit) throw new Error('The recovery checkpoint cannot be verified');
try { fs.lstatSync(saved.path); throw new Error('The worktree path already exists; it will not be overwritten'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { randomUUID } = require('node:crypto');
let branch = saved.branch;
if (branch !== undefined) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Invalid archived branch name');
  git(['check-ref-format', `refs/heads/${branch}`]);
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    branch = undefined;
  } catch (error) { if (error.status !== 1) throw error; }
}
branch ??= `piop-restored-${randomUUID()}`;
git(['worktree', 'add', '-b', branch, saved.path, saved.commit]);
restoreSession(() => {
  git(['worktree', 'remove', '--force', saved.path]);
  git(['branch', '-D', branch]);
});
process.stdout.write(JSON.stringify({ path: saved.path, branch, sessionPath: destination }));
