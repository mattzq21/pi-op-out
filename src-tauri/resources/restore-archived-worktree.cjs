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
if (header?.type !== 'session' || !saved || !path.isAbsolute(saved.path ?? '') || !path.isAbsolute(saved.repositoryRoot ?? '')
  || typeof saved.ref !== 'string' || !saved.ref.startsWith('refs/pi-session-snapshots/')
  || !/^[a-f0-9]{40,64}$/.test(saved.commit ?? '')) throw new Error('No saved worktree checkpoint is available');
// Both paths were canonicalized before deletion; the original cwd may be an alias.
const conversationPath = saved.conversationPath ?? header.cwd;
if (typeof conversationPath !== 'string' || !path.isAbsolute(conversationPath)) throw new Error('Invalid archived conversation location');
const relative = path.relative(saved.path, conversationPath);
if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid archived worktree location');
const git = (args) => execFileSync('git', ['-C', saved.repositoryRoot, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (git(['rev-parse', '--verify', saved.ref]) !== saved.commit) throw new Error('The last response checkpoint is missing or has changed');
const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
let cursor = entries.at(-1);
let response;
const visited = new Set();
while (cursor && !visited.has(cursor.id)) {
  visited.add(cursor.id);
  if (cursor.type === 'message' && cursor.message?.role === 'assistant') { response = cursor; break; }
  cursor = byId.get(cursor.parentId);
}
const snapshot = response && entries.findLast((entry) => entry.type === 'custom' && entry.customType === 'pi-project-files-watch-snapshot'
  && entry.data?.responseEntryIds?.includes(response.id));
if (!snapshot || snapshot.data.unavailable || snapshot.data.ref !== saved.ref || snapshot.data.commit !== saved.commit) throw new Error('The last response checkpoint cannot be verified');
try { fs.lstatSync(saved.path); throw new Error('The worktree path already exists; it will not be overwritten'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// A fresh branch keeps the saved state exact without resetting an existing branch.
const { randomUUID } = require('node:crypto');
const branch = `piop-restored-${randomUUID()}`;
git(['worktree', 'add', '-b', branch, saved.path, saved.commit]);
process.stdout.write(JSON.stringify({ path: saved.path, branch }));
