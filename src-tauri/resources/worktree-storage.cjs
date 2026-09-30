const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [action, directory, storage, branch] = process.argv.slice(1);
const root = path.join(os.homedir(), storage, 'worktrees');

function cleanup(target) {
  const container = path.dirname(target);
  if (path.dirname(container) !== root || !/^[a-f0-9]{4}$/.test(path.basename(container))) return;
  if (fs.existsSync(target)) return;
  try { fs.unlinkSync(path.join(container, 'parent.json')); } catch { }
  try { fs.rmdirSync(container); } catch { }
}

function allocate() {
  let parentBranch = null;
  try { parentBranch = execFileSync('git', ['-C', directory, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { }
  const listed = execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const worktrees = listed.split('\0').filter((entry) => entry.startsWith('worktree ')).map((entry) => entry.slice(9));
  if (!worktrees.length) throw new Error('Could not locate the main checkout');
  const project = path.basename(worktrees[0]);
  if (!project) throw new Error('Git repository directory has no name');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const container = path.join(root, randomUUID().slice(0, 4));
  const target = path.join(container, project);
  if (worktrees.includes(target)) throw new Error(`Git worktree is already registered: ${target}`);
  try { fs.mkdirSync(container, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Worktree directory already exists: ${container}`); throw error; }
  try { fs.writeFileSync(path.join(container, 'parent.json'), JSON.stringify({ branch, parentBranch }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { cleanup(target); throw error; }
  process.stdout.write(target);
}

try {
  if (action === 'cleanup') cleanup(directory);
  else if (action === 'allocate') allocate();
  else throw new Error('Unknown worktree storage operation');
} catch (error) { console.error(error.message); process.exitCode = 1; }
