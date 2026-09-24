const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const target = process.argv[1];
const archive = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'archived');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commonDirectory = (cwd) => fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const common = commonDirectory(target);
const sameRepository = (cwd) => { try { return typeof cwd === 'string' && commonDirectory(cwd) === common; } catch { return false; } };
const verifyRef = (ref, commit) => {
  if (typeof ref !== 'string' || !ref.startsWith('refs/pi-session-snapshots/') || !/^[a-f0-9]{40,64}$/.test(commit ?? '') || git(common, ['rev-parse', '--verify', ref]) !== commit) throw new Error('Could not preserve archived conversation checkpoints before deleting the worktree');
};

function preserve(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return;
  const body = fs.readFileSync(file, 'utf8');
  const lines = body.split('\n');
  let entries;
  try { entries = lines.filter((line) => line.trim()).map(JSON.parse); } catch { return; }
  const header = entries[0];
  if (header?.type !== 'session' || typeof header.id !== 'string') return;
  let changed = false;
  // Follow the selected conversation branch, rather than an abandoned response.
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  let cursor = entries.at(-1);
  let response;
  const visited = new Set();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.type === 'message' && cursor.message?.role === 'assistant') { response = cursor; break; }
    cursor = byId.get(cursor.parentId);
  }
  const snapshot = response && entries.findLast((entry) => entry.type === 'custom'
    && entry.customType === 'pi-project-files-watch-snapshot'
    && entry.data?.responseEntryIds?.includes(response.id));
  if (typeof header.cwd === 'string' && sameRepository(header.cwd)
    && fs.realpathSync(git(header.cwd, ['rev-parse', '--show-toplevel'])) === fs.realpathSync(target)) {
    // Never substitute a prompt checkpoint or capture the files being deleted.
    if (!snapshot || snapshot.data?.unavailable) throw new Error('The archived conversation has no checkpoint for its last response');
    verifyRef(snapshot.data.ref, snapshot.data.commit);
    header.worktreeRestore = { path: fs.realpathSync(target), conversationPath: fs.realpathSync(header.cwd), repositoryRoot: common, ref: snapshot.data.ref, commit: snapshot.data.commit };
    changed = true;
  }
  const promptRoot = header.checkpointRepositoryRoot ?? header.cwd;
  const prompts = entries.filter((entry) => entry.type === 'custom' && entry.customType === 'pi-project-prompt-checkpoint' && !entry.data?.unavailable);
  if (prompts.length && promptRoot !== common && sameRepository(promptRoot)) {
    const id = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';
    for (const entry of prompts) {
      if (!/^[a-zA-Z0-9-]+$/.test(entry.data?.key ?? '')) throw new Error('Invalid archived prompt checkpoint');
      verifyRef(`refs/pi-session-snapshots/chats/${id}/prompts/${entry.data.key}`, entry.data.commit);
    }
    header.checkpointRepositoryRoot = common;
    changed = true;
  }
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== 'pi-project-files-watch-snapshot' || entry.data?.unavailable) continue;
    const data = entry.data;
    if (data?.repositoryRoot === common || !sameRepository(data?.repositoryRoot)) continue;
    verifyRef(data.ref, data.commit);
    data.repositoryRoot = common;
    changed = true;
  }
  if (!changed) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', stat.mode & 0o777);
    fs.writeFileSync(fd, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const current = fs.lstatSync(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error('An archived conversation changed while preserving its checkpoints');
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function visit(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) preserve(file);
  }
}
visit(archive);
