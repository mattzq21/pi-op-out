const database = require('./session-database.cjs');
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
  const value = require('./session-database.cjs').worktreeMetadata(container);

  if (!value || value.containerIdentity !== identity(info)) return false;

  if (Object.hasOwn(value, 'allocation')) return ownsAllocation(value, container, info);

  if (Object.hasOwn(value, 'branch') && !Check(parentSchema, value)) return false;

  return Number(info.ctimeMs) < boot;
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

  for (const container of require('./session-database.cjs').worktreeContainers(root)) {
    if (path.dirname(container) !== storage || !/^[a-f0-9]{4}$/.test(path.basename(container))) throw new Error('Invalid worktree allocation path');
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

function retainCandidate(root, candidate) {
  const key = createHash('sha256').update('worktree-allocation:' + JSON.stringify(candidate)).digest('hex');
  const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
  recordRetention(root, id, { directories: [candidate], sessionIds: [] });
}

function collectWorktreeAllocations(root) {
  const revision = database.cleanupRequest(root, 'worktree');

  if (revision === undefined) return;
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

  if (!pending) database.finishCleanup(root, 'worktree', revision);
}

module.exports = { collectWorktreeAllocations };
