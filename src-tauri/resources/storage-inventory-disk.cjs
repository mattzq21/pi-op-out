const fs = require('node:fs/promises');
const path = require('node:path');
const { validGoalPath } = require('./storage-inventory-owners.cjs');

const localCategories = { sessions: 'active-conversations', archived: 'archived-conversations', 'git-snapshots': 'git-diff-snapshots', tmp: 'temporary-chats', worktrees: 'worktrees', 'archived-tmp': 'archived-worktrees', recovery: 'unattributed-recovery-storage', 'ephemeral-cleanup': 'ephemeral-cleanup' };

function specialCategory(target, category, metadata, discovery) {
  if (!metadata.isDirectory()) return category;

  if (discovery.pendingSnapshots.has(target)) return 'pending-diff-snapshots';

  if (discovery.recovery.has(target)) return discovery.recovery.get(target).ownership === 'owned' ? 'recovery-storage' : 'unattributed-recovery-storage';

  const knownGoal = discovery.goals.has(target) || ['active-conversations', 'archived-conversations'].includes(category);

  if (knownGoal && validGoalPath(target)) return goalCategory(target, discovery);

  return snapshotCategory(target, category);
}

function snapshotCategory(target, category) {
  if (!target.endsWith('.snapshots')) return category;

  if (category === 'active-conversations') return 'git-diff-snapshots';

  if (category === 'archived-conversations') return 'archived-git-diff-snapshots';

  return category;
}

function goalCategory(target, discovery) {
  return discovery.goals.get(target)?.owners.some(owner => owner.kind !== 'unresolved') ? 'goal-attachments' : 'unattributed-goal-attachments';
}

async function diskStorage(profile, discovery, referencedWorktrees, git) {
  const sizes = new Map();
  const counts = new Map();
  const seen = new Set();
  const directories = new Set();
  const roots = new Map();
  const worktrees = new Set();
  const warnings = [];
  const unavailable = new Set();
  const root = await fs.realpath(profile).catch(() => profile);

  function addCount(category, amount = 1) { counts.set(category, (counts.get(category) || 0) + amount); }

  function register(category, record) {
    if (!roots.has(category)) roots.set(category, new Map());
    roots.get(category).set(record.path, record);
  }

  function countDirectory(target, category, entries) {
    if (category === 'other-storage') addCount(category, entries.filter(entry => entry.isFile()).length);

    if (category === 'ephemeral-cleanup') addCount(category, entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length);

    if (category === 'chatgpt-storage') addCount(category, entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9-]{1,100}\.json$/.test(entry.name)).length);
    countSnapshots(target, category, entries);
    countWorkdirs(target, category, entries);

    if (['goal-attachments', 'unattributed-goal-attachments'].includes(category) && validGoalPath(target)) {
      addCount(category);
      const record = discovery.goals.get(target) || { path: target, ownership: 'unattributed', provenance: ['Goal asset directory without a readable surviving reference'], owners: [] };
      record.available = true;
      record.directory = true;
      register(category, record);
    }
  }

  function countSnapshots(target, category, entries) {
    if (['git-diff-snapshots', 'archived-git-diff-snapshots'].includes(category) && entries.some(entry => entry.name === 'snapshot.json')) addCount(category);

    if (target === path.join(root, 'git-snapshots')) addCount(category, entries.filter(entry => entry.isDirectory() && entry.name.startsWith('pi-desktop-diff-') && !discovery.pendingSnapshots.has(path.join(target, entry.name))).length);

    if (discovery.pendingSnapshots.has(target)) addCount('pending-diff-snapshots');

    if (['git-diff-snapshots', 'archived-git-diff-snapshots'].includes(category) && target.endsWith('.snapshots')) register(category, { path: target, ownership: 'owned', provenance: ['Conversation diff snapshot sidecar'], owners: [], available: true, directory: true });
  }

  function countWorkdirs(target, category, entries) {
    if ([path.join(root, 'tmp'), path.join(root, 'archived-tmp')].includes(target)) addCount(category, entries.filter(entry => entry.isDirectory()).length);
    const relative = path.relative(path.join(root, 'worktrees'), target).split(path.sep);

    if (category === 'worktrees' && relative.length === 2 && !relative.includes('..') && entries.some(entry => entry.name === '.git')) worktrees.add(target);
  }

  async function visit(target, category, required = false) {
    try {
      const metadata = await fs.lstat(target);
      category = specialCategory(target, category, metadata, discovery);
      const identity = `${metadata.dev}:${metadata.ino}`;

      if (seen.has(identity)) return;
      seen.add(identity);
      const bytes = Number.isFinite(metadata.blocks) ? metadata.blocks * 512 : metadata.size;
      sizes.set(category, (sizes.get(category) || 0) + bytes);

      if (!metadata.isDirectory()) return;
      directories.add(target);
      const entries = await fs.readdir(target, { withFileTypes: true });
      countDirectory(target, category, entries);

      for (const entry of entries) {
        const nextCategory = childCategory(target, entry.name, category);
        await visit(path.join(target, entry.name), nextCategory, true);
      }
    } catch (error) {
      unavailable.add(target);

      if (required || error.code !== 'ENOENT') warnings.push(`${target}: storage unavailable: ${error.message}`);
    }
  }

  function childCategory(target, name, category) {
    return target === root ? localCategories[name] || 'other-storage' : category;
  }

  async function visitRecord(category, record) {
    register(category, record);

    try {
      const metadata = await fs.lstat(record.path);
      record.available = !metadata.isSymbolicLink();

      if (!record.available) throw new Error('Root is a symbolic link; target ownership and bytes are unresolved');
      const canonical = await fs.realpath(record.path);
      await visit(canonical, category, true);
      record.available = !unavailable.has(canonical);
      record.directory = metadata.isDirectory();
    } catch (error) { record.available = false; warnings.push(`${record.path}: storage unavailable: ${error.message}`); }
  }

  async function visitRecovery(record) {
    const category = record.ownership === 'owned' ? 'recovery-storage' : 'unattributed-recovery-storage';
    addCount(category);
    await visitRecord(category, record);

    if (record.state === 'allocated' || !record.workdir) return;

    try { if (!(await fs.lstat(record.workdir)).isDirectory()) throw new Error('Recovery workdir is not a directory'); }
    catch (error) { warnings.push(`${record.workdir}: ${record.state} recovery workdir unavailable: ${error.message}`); record.available = false; }
  }

  async function visitManagedWorktree(worktree) {
    const record = { path: worktree, ownership: 'owned', provenance: ['Worktree in Piop allocation namespace'], owners: [], available: true, directory: true };
    register('worktrees', record);

    try { await visit((await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim(), 'worktrees', true); }
    catch (error) { warnings.push(`${worktree}: Git administration storage unavailable: ${error.message}`); }
  }

  async function visitReferencedWorktree(record) {
    const canonical = await fs.realpath(record.path).catch(() => record.path);

    if (directories.has(canonical)) return;
    addCount('referenced-worktrees');
    await visitRecord('referenced-worktrees', record);

    try { await visit((await git(record.path, ['rev-parse', '--absolute-git-dir'])).trim(), 'referenced-worktrees', true); }
    catch (error) { warnings.push(`${record.path}: referenced worktree metadata unavailable: ${error.message}`); }
  }

  async function visitCandidates(records, category) {
    for (const record of records.values()) { addCount(category); await visitRecord(category, record); }
  }

  async function visitKnownRecords(records, category) {
    for (const record of records.values()) await visitRecord(category, record);
  }

  await visit(root, 'other-storage');

  for (const [name, category] of Object.entries(localCategories)) {
    const target = path.join(root, name);

    if (directories.has(target)) register(category, { path: target, ownership: category === 'unattributed-recovery-storage' ? 'unattributed' : 'owned', provenance: ['Piop profile namespace'], owners: [], available: true, directory: true });
  }

  register('other-storage', { path: root, ownership: 'owned', provenance: ['PIOP_STORAGE_DIRECTORY profile'], owners: [], available: directories.has(root), directory: true });

  for (const record of discovery.recovery.values()) await visitRecovery(record);

  for (const record of discovery.chatgpt.values()) await visitRecord('chatgpt-storage', record);
  await visitCandidates(discovery.legacy, 'legacy-recovery-storage');
  await visitCandidates(discovery.ephemeral, 'ephemeral-storage');

  await visitKnownRecords(discovery.cleanup, 'ephemeral-cleanup');

  await visitKnownRecords(discovery.pendingSnapshots, 'pending-diff-snapshots');

  for (const record of discovery.goals.values()) await visitRecord(record.owners.some(owner => owner.kind !== 'unresolved') ? 'goal-attachments' : 'unattributed-goal-attachments', record);

  for (const worktree of worktrees) await visitManagedWorktree(worktree);
  counts.set('worktrees', worktrees.size);

  for (const record of referencedWorktrees.values()) await visitReferencedWorktree(record);

  return { sizes, counts, directories, roots, warnings };
}

module.exports = { diskStorage };
