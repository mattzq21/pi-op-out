const fs = require('node:fs/promises');
const path = require('node:path');
const { validGoalPath } = require('./storage-inventory-owners.cjs');
const { goalOwner } = require('./storage-inventory-goals.cjs');
const { stageCategory, observeStage } = require('./storage-inventory-transfers.cjs');
const snapshotMetadata = require('./snapshot-metadata.cjs');
const { chatGptStoredCount } = require('./chatgpt-storage.mjs');

const localCategories = { sessions: 'active-conversations', archived: 'archived-conversations', 'git-snapshots': 'git-diff-snapshots', 'git-diff-transfers': 'diff-transfer-staging', tmp: 'temporary-chats', worktrees: 'worktrees', 'archived-tmp': 'archived-worktrees', recovery: 'unattributed-recovery-storage' };

function savedSnapshotIdentities(profile, warnings) {
  try { return new Set(snapshotMetadata.identities(profile)); }
  catch (error) { warnings.push(`${profile}: snapshot record count unavailable: ${error.message}`);

  return new Set(); }
}

function savedSnapshotDirectories(profile, warnings) {
  try {
    return new Set(require('./session-database.cjs').snapshotDirectories(profile).map(row => {
      if (path.dirname(row.directory) !== path.join(profile, 'git-snapshots')) throw new Error('Invalid saved snapshot directory');

      return row.directory;
    }));
  } catch (error) { warnings.push(`${profile}: snapshot directories unavailable: ${error.message}`);

  return new Set(); }
}

function specialCategory(target, category, metadata, discovery) {
  category = queuedCategory(target, category, metadata, discovery);

  if (!metadata.isDirectory()) return stageCategory(target, category, metadata, discovery);

  if (discovery.pendingSnapshots.has(target)) return 'pending-diff-snapshots';

  if (discovery.recovery.has(target)) return discovery.recovery.get(target).ownership === 'owned' ? 'recovery-storage' : 'unattributed-recovery-storage';

  const knownGoal = discovery.goals.has(target) || ['active-conversations', 'archived-conversations'].includes(category);

  if (knownGoal && validGoalPath(target)) return goalCategory(target, discovery);

  return snapshotCategory(target, category);
}

function queuedCategory(target, category, metadata, discovery) {
  return metadata.isFile() && discovery.queuedInput?.has(target) ? discovery.queuedInput.get(target).category : category;
}

function snapshotCategory(target, category) {
  if (!target.endsWith('.snapshots')) return category;

  if (category === 'active-conversations') return 'git-diff-snapshots';

  if (category === 'archived-conversations') return 'archived-git-diff-snapshots';

  return category;
}

function goalCategory(target, discovery) {
  return goalOwner(discovery.goals.get(target)) ? 'goal-attachments' : 'unattributed-goal-attachments';
}

async function diskStorage(profile, discovery, referencedWorktrees, git) {
  const sizes = new Map();
  const counts = new Map();
  const seen = new Set();
  const seenQueuedInput = new Set();
  const directories = new Set();
  const roots = new Map();
  const warnings = [];
  const unavailable = new Set();
  const root = await fs.realpath(profile).catch(() => profile);
  const chatRoots = new Set(await Promise.all([...discovery.chatgpt.keys()].map(directory => fs.realpath(directory).catch(() => directory))));

  const savedSnapshots = savedSnapshotIdentities(root, warnings);
  const snapshotDirectories = savedSnapshotDirectories(root, warnings);
  const savedSnapshotFiles = new Set([...savedSnapshots].map(key => key.split(':').slice(0, 2).map(Number).join(':')));

  function addCount(category, amount = 1) { counts.set(category, (counts.get(category) || 0) + amount); }

  function register(category, record) {
    if (!roots.has(category)) roots.set(category, new Map());
    roots.get(category).set(record.path, record);
  }

  function countStage(target, category, metadata) {
    const record = observeStage(target, category, metadata, discovery);

    if (!record) return;
    register(category, record);

    if (metadata.isFile()) addCount(category);
  }

  function observeQueue(target, metadata) {
    if (metadata.isFile() && discovery.queuedInput?.has(target)) seenQueuedInput.add(target);
  }

  async function countChats() {
    for (const directory of chatRoots) {
      try {
        if (!(await fs.lstat(directory)).isDirectory()) throw new Error('ChatGPT storage is not a directory');
        addCount('chatgpt-storage', chatGptStoredCount(directory));
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(directory + ': ChatGPT chat count unavailable: ' + error.message);
      }
    }
  }

  function registerQueuedInputs() {
    for (const [file, queued] of discovery.queuedInput ?? []) {
      register(queued.category, { path: file, ownership: 'owned', provenance: ['Conversation queued input'], owners: queued.owners, available: seenQueuedInput.has(file), directory: false });
    }
  }

  function countDirectory(target, category, entries, metadata) {
    if (category === 'other-storage') addCount(category, entries.filter(entry => entry.isFile() && !discovery.queuedInput?.has(path.join(target, entry.name))).length);

    countSnapshots(target, category, entries, metadata);

    if (['goal-attachments', 'unattributed-goal-attachments'].includes(category) && validGoalPath(target)) {
      addCount(category);
      const record = discovery.goals.get(target) || { path: target, ownership: 'unattributed', provenance: ['Goal asset directory without a readable surviving reference'], owners: [] };
      record.available = true;
      record.directory = true;
      register(category, record);
    }
  }

  function savedSnapshot(target, entries, metadata) {
    if (snapshotDirectories.has(target)) return true;

    if (savedSnapshotFiles.has(`${metadata.dev}:${metadata.ino}`) && savedSnapshots.has(snapshotMetadata.identity(target))) return true;

    if (!entries.some(entry => entry.name === 'snapshot.json')) return false;

    try { return snapshotMetadata.read(target) !== undefined; }
    catch (error) { warnings.push(`${target}: snapshot record unavailable: ${error.message}`);

    return false; }
  }

  function countSnapshots(target, category, entries, metadata) {
    const pending = discovery.pendingSnapshots.has(target);

    if (!pending && ['git-diff-snapshots', 'archived-git-diff-snapshots'].includes(category) && savedSnapshot(target, entries, metadata)) addCount(category);

    if (pending) addCount('pending-diff-snapshots');

    if (['git-diff-snapshots', 'archived-git-diff-snapshots'].includes(category) && target.endsWith('.snapshots')) register(category, { path: target, ownership: 'owned', provenance: ['Conversation diff snapshot sidecar'], owners: [], available: true, directory: true });
  }

  async function visit(target, category, required = false) {
    try {
      const metadata = await fs.lstat(target);
      category = specialCategory(target, category, metadata, discovery);

      observeQueue(target, metadata);
      const identity = `${metadata.dev}:${metadata.ino}`;

      if (seen.has(identity)) return;
      seen.add(identity);
      const bytes = Number.isFinite(metadata.blocks) ? metadata.blocks * 512 : metadata.size;
      sizes.set(category, (sizes.get(category) || 0) + bytes);
      countStage(target, category, metadata);

      if (!metadata.isDirectory()) return;
      directories.add(target);
      const entries = await fs.readdir(target, { withFileTypes: true });
      countDirectory(target, category, entries, metadata);

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
      const metadata = await fs.lstat(record.path, { bigint: true });
      record.available = !metadata.isSymbolicLink();

      if (!record.available) throw new Error('Root is a symbolic link; target ownership and bytes are unresolved');
      const canonical = await fs.realpath(record.path);

      if (record.expectedIdentity && (canonical !== record.path || record.expectedIdentity !== metadata.dev + ':' + metadata.ino)) throw new Error('Retained artifact identity or ancestry differs from its durable provenance; bytes remain counted in the profile scan');
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
    const record = { path: worktree, ownership: 'owned', provenance: ['Saved Piop worktree allocation'], owners: [], available: !unavailable.has(worktree), directory: true };
    register('worktrees', record);

    try { await visit((await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim(), 'worktrees', true); }
    catch (error) { warnings.push(`${worktree}: Git administration storage unavailable: ${error.message}`); }
  }

  async function visitManagedWorktrees() {
    try {
      const records = require('./worktree-inventory.cjs').list(root);
      warnings.push(...records.warnings);
      const saved = new Set(records.paths);
      const present = [...saved].filter(target => directories.has(target));
      counts.set('worktrees', present.length);

      for (const target of present) await visitManagedWorktree(target);
    } catch (error) { warnings.push(`${root}: worktree records unavailable: ${error.message}`); }
  }

  function registerTemporaryChats() {
    try {
      for (const row of require('./temporary-chat-inventory.cjs').list(root)) {
        if (!directories.has(row.original_path)) continue;
        addCount('temporary-chats');
        register('temporary-chats', { path: row.original_path, ownership: 'owned', provenance: ['Saved temporary chat creation: ' + row.session_id], owners: [], available: !unavailable.has(row.original_path), directory: true });
      }
    } catch (error) { warnings.push(`${root}: temporary chat records unavailable: ${error.message}`); }
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

  async function visitTransfers() {
    for (const record of discovery.transfers.values()) await visitRecord(record.ownership === 'owned' ? 'diff-transfer-staging' : 'unattributed-diff-transfer-staging', record);
  }

  async function inspectResourcePins(record) {
    for (const pin of record.pins || []) {
      record.provenance.push('Shared resource Git pin: ' + pin.root + ' ' + pin.ref + ' -> ' + pin.commit);

      try {
        const metadata = await fs.lstat(pin.root, { bigint: true });

        if (!metadata.isDirectory() || await fs.realpath(pin.root) !== pin.root || pin.identity !== metadata.dev + ':' + metadata.ino) throw new Error('Pinned repository directory identity changed');

        if ((await git(pin.root, ['rev-parse', '--verify', pin.ref])).trim() !== pin.commit) throw new Error('Shared resource pin no longer matches its recorded commit');

        if (directories.has(pin.root)) record.provenance.push('Shared resource pin object files already included in the allocated-block directory scan');
        else warnings.push(`${pin.root}: retained shared resource pin ${pin.ref}; object bytes are outside measured directories and the session checkpoint estimate; shared archive Git coverage is incomplete`);
      } catch (error) { warnings.push(`${pin.root}: shared resource pin unavailable: ${error.message}; retained`); }
    }
  }

  async function visitRetainedArtifacts() {
    for (const record of discovery.retainedArtifacts.values()) {
      await visitRecord(record.category, record);

      if (record.category === 'archived-worktrees' && record.available && record.directory) addCount(record.category);
      await inspectResourcePins(record);
    }
  }

  await countChats();
  await visit(root, 'other-storage');
  registerTemporaryChats();

  for (const [name, category] of Object.entries(localCategories)) {
    const target = path.join(root, name);

    if (directories.has(target)) register(category, { path: target, ownership: category === 'unattributed-recovery-storage' ? 'unattributed' : 'owned', provenance: ['Piop profile namespace'], owners: [], available: true, directory: true });
  }

  register('other-storage', { path: root, ownership: 'owned', provenance: ['PIOP_STORAGE_DIRECTORY profile'], owners: [], available: directories.has(root), directory: true });

  for (const record of discovery.recovery.values()) await visitRecovery(record);

  for (const record of discovery.chatgpt.values()) await visitRecord('chatgpt-storage', record);
  await visitCandidates(discovery.legacy, 'legacy-recovery-storage');


  await visitKnownRecords(discovery.pendingSnapshots, 'pending-diff-snapshots');

  await visitTransfers();

  for (const record of discovery.goals.values()) await visitRecord(goalOwner(record) ? 'goal-attachments' : 'unattributed-goal-attachments', record);

  await visitManagedWorktrees();

  for (const record of referencedWorktrees.values()) await visitReferencedWorktree(record);

  await visitRetainedArtifacts();

  registerQueuedInputs();

  return { sizes, counts, directories, roots, warnings };

}

module.exports = { diskStorage };
