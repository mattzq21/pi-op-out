const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { collectRetention } = require('./deletion-retention.cjs');
const { recordRetention } = require('./retention-candidates.cjs');
const { directoryInUse } = require('./directory-liveness.cjs');
const { containerContents } = require('./worktree-container.cjs');

const allocationSchema = Type.Object({ allocation: Type.Object({ version: Type.Literal(1), identity: Type.String(), target: Type.String() }) });

const parentSchema = Type.Object({ branch: Type.String(), parentBranch: Type.Union([Type.String(), Type.Null()]) });

function metadata(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}

function identity(info) { return `${info.dev}:${info.ino}`; }

function bootTime() {
  if (process.platform !== 'linux') return 0;
  const boot = fs.readFileSync('/proc/stat', 'utf8').split('\n').find(line => line.startsWith('btime '));

  return Number(boot?.slice(6)) * 1000 || 0;
}

function contents(container) {
  return Boolean(containerContents(container));
}

function ownsAllocation(value, container, info) {
  return Check(allocationSchema, value) && value.allocation.identity === identity(info)
    && path.dirname(value.allocation.target) === container;
}

function ownership(container, info, boot) {
  if (containerContents(container, info)?.pending) return true;
  const parent = path.join(container, 'parent.json');
  const parentInfo = metadata(parent);
  let value;

  if (parentInfo) {
    if (!parentInfo.isFile()) return false;

    try { value = JSON.parse(fs.readFileSync(parent, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }

    if (Object.hasOwn(value ?? {}, 'allocation')) return ownsAllocation(value, container, info);

    if (!Check(parentSchema, value)) return false;
  }

  return Number(info.ctimeMs) < boot && (!parentInfo || Number(parentInfo.ctimeMs) < boot);
}

function emptyAllocation(container, info, boot) {
  return info?.isDirectory() && contents(container) && ownership(container, info, boot);
}

function candidates(root) {
  const storage = path.join(root, 'worktrees');
  const info = metadata(storage);

  if (!info) return [];

  if (!info.isDirectory() || fs.realpathSync(storage) !== storage) throw new Error('Invalid worktree allocation storage');
  const boot = bootTime();
  const selected = [];

  for (const entry of fs.readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{4}$/.test(entry.name)) continue;
    const container = path.join(storage, entry.name);
    const info = metadata(container);

    if (!emptyAllocation(container, info, boot)) continue;
    selected.push({ path: container, identity: identity(info) });
  }

  return selected;
}

function removableContainer(candidate) {
  const info = metadata(candidate.path);

  return info?.isDirectory() && identity(info) === candidate.identity && contents(candidate.path) && !directoryInUse(candidate.path);
}

function sync(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function retainCandidate(root, candidate) {
  const key = createHash('sha256').update('worktree-allocation:' + JSON.stringify(candidate)).digest('hex');
  const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
  recordRetention(root, id, { directories: [candidate], sessionIds: [] });
}

function collectWorktreeAllocations(root) {
  const marker = path.join(root, 'worktree-retention.pending');
  const info = metadata(marker);

  if (!info) return;

  if (!info.isFile()) throw new Error('Invalid worktree allocation recovery marker');
  const selected = candidates(root);
  const retention = selected.length ? collectRetention(root, [], [], { directories: selected.map(candidate => candidate.path), sessionIds: [] }) : { directories: [] };
  const removable = new Set(retention.directories);
  const ready = [];
  let pending = false;

  for (const candidate of selected) {
    if (removable.has(candidate.path) && removableContainer(candidate)) ready.push(candidate);
    else pending = true;
  }

  for (const candidate of ready) retainCandidate(root, candidate);

  if (!pending) { fs.unlinkSync(marker); sync(root); }
}

module.exports = { collectWorktreeAllocations };
