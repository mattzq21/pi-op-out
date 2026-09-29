const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const [action, target, source, storage] = process.argv.slice(1);
function git(directory, args, input) {
  return execFileSync('git', ['-C', directory, '-c', 'core.fsmonitor=false', ...args], { input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function parentMetadata() {
  const container = path.dirname(target);
  const root = path.join(os.homedir(), storage, 'worktrees');
  if (path.dirname(container) !== root || !/^[a-f0-9]{4}$/.test(path.basename(container))) return null;
  const metadata = JSON.parse(fs.readFileSync(path.join(container, 'parent.json'), 'utf8'));
  if (typeof metadata.branch !== 'string' || typeof metadata.parentBranch !== 'string') return null;
  if (!metadata.parentBranch.startsWith('refs/heads/')) return null;
  const branch = git(target, ['symbolic-ref', '--quiet', 'HEAD']).trim();
  if (branch !== `refs/heads/${metadata.branch}` || branch === metadata.parentBranch) return null;
  git(target, ['check-ref-format', metadata.parentBranch]);
  return metadata;
}

function cleanWorktree() {
  if (git(target, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no', '--ignore-submodules=none']).length) return false;
  const files = git(target, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  if (files.some((entry) => entry[0] !== 'H')) return false;
  const gitDir = git(target, ['rev-parse', '--absolute-git-dir']).trim();
  return !['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'].some((name) => fs.existsSync(path.join(gitDir, name)));
}

function eligible() {
  const metadata = parentMetadata();
  if (!metadata || !cleanWorktree()) return null;
  const branchRef = `refs/heads/${metadata.branch}`;
  const records = git(target, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean);
  const own = records.find((record) => record.split('\0').includes(`worktree ${target}`));
  if (!own || records[0] === own || own.split('\0').some((line) => line.startsWith('locked'))) return null;
  if (records.filter((record) => record.split('\0').includes(`branch ${branchRef}`)).length !== 1) return null;
  const tip = git(target, ['rev-parse', '--verify', branchRef]).trim();
  const parentTip = git(target, ['rev-parse', '--verify', metadata.parentBranch]).trim();
  git(target, ['merge-base', '--is-ancestor', tip, parentTip]);
  return { ...metadata, branchRef, tip, parentTip };
}

function removeBranch(metadata) {
  const records = git(source, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  if (records.includes(`branch ${metadata.branchRef}`)) throw new Error('Branch is now checked out in another worktree');
  git(source, ['update-ref', '--stdin'], [
    'start', `verify ${metadata.parentBranch} ${metadata.parentTip}`,
    `delete ${metadata.branchRef} ${metadata.tip}`, 'prepare', 'commit', '',
  ].join('\n'));
  try { git(source, ['config', '--local', '--remove-section', `branch.${metadata.branch}`]); } catch { }
}

try {
  const metadata = eligible();
  if (metadata && action === 'check') process.stdout.write('eligible');
  else if (metadata && action === 'remove') {
    git(source, ['worktree', 'remove', '--', target]);
    removeBranch(metadata);
    fs.unlinkSync(path.join(path.dirname(target), 'parent.json'));
    fs.rmdirSync(path.dirname(target));
  }
} catch (error) {
  if (action === 'remove') { console.error(error.message); process.exitCode = 1; }
}
