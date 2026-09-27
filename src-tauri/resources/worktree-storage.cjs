const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [action, directory, storage] = process.argv.slice(1);
const root = path.join(os.homedir(), storage, 'worktrees');

function cleanup(target) {
  const container = path.dirname(target);
  if (path.dirname(container) !== root || !/^[a-f0-9]{4}$/.test(path.basename(container))) return;
  try { fs.rmdirSync(container); } catch { }
}

function allocate() {
  const listed = execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const worktrees = listed.split('\0').filter((entry) => entry.startsWith('worktree ')).map((entry) => entry.slice(9));
  if (!worktrees.length) throw new Error('Could not locate the main checkout');
  const project = path.basename(worktrees[0]);
  if (!project) throw new Error('Git repository directory has no name');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 256; attempt++) {
    const container = path.join(root, randomUUID().slice(0, 4));
    const target = path.join(container, project);
    if (worktrees.includes(target)) continue;
    try { fs.mkdirSync(container, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    process.stdout.write(target);
    return;
  }
  throw new Error('Could not allocate a unique worktree directory');
}

try {
  if (action === 'cleanup') cleanup(directory);
  else if (action === 'allocate') allocate();
  else throw new Error('Unknown worktree storage operation');
} catch (error) { console.error(error.message); process.exitCode = 1; }
