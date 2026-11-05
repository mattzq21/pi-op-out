const fs = require('node:fs/promises');
const path = require('node:path');
const localCategories = { sessions: 'active-conversations', tmp: 'temporary-chats', worktrees: 'chat-worktrees', recovery: 'unattributed-recovery-storage', 'goal-files': 'goal-files' };

function specialCategory(target, category, metadata, discovery) {
  category = queuedCategory(target, category, metadata, discovery);

  if (category === 'active-conversations' && discovery.archived?.has(target)) return 'archived-conversations';

  if (!metadata.isDirectory()) return category;

  if (discovery.recovery.has(target)) return discovery.recovery.get(target).ownership === 'owned' ? 'recovery-storage' : 'unattributed-recovery-storage';

  return category;
}

function queuedCategory(target, category, metadata, discovery) {
  return metadata.isFile() && discovery.queuedInput?.has(target) ? discovery.queuedInput.get(target).category : category;
}

async function diskStorage(profile, discovery) {
  const sizes = new Map();
  const counts = new Map();
  const seen = new Set();
  const seenQueuedInput = new Set();
  const directories = new Set();
  const roots = new Map();
  const warnings = [];
  const unavailable = new Set();
  const root = await fs.realpath(profile).catch(() => profile);

  function addCount(category, amount = 1) { counts.set(category, (counts.get(category) || 0) + amount); }

  function register(category, record) {
    if (!roots.has(category)) roots.set(category, new Map());
    roots.get(category).set(record.path, record);
  }

  function observeQueue(target, metadata) {
    if (metadata.isFile() && discovery.queuedInput?.has(target)) seenQueuedInput.add(target);
  }

  function registerQueuedInputs() {
    for (const [file, queued] of discovery.queuedInput ?? []) {
      register(queued.category, { path: file, ownership: 'owned', provenance: ['Conversation queued input'], owners: queued.owners, available: seenQueuedInput.has(file), directory: false });
    }
  }

  function countDirectory(target, category, entries) {
    if (category === 'chat-worktrees' && target === path.join(root, 'worktrees')) addCount(category, entries.filter(entry => entry.isDirectory()).length);

    if (category === 'other-storage') addCount(category, entries.filter(entry => entry.isFile() && !discovery.queuedInput?.has(path.join(target, entry.name))).length);

    if (category === 'goal-files' && target === path.join(root, 'goal-files')) addCount(category, entries.filter(entry => entry.isFile()).length);
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

  function registerTemporaryChats() {
    try {
      for (const row of require('./temporary-chat-inventory.cjs').list(root)) {
        if (!directories.has(row.original_path)) continue;
        addCount('temporary-chats');
        register('temporary-chats', { path: row.original_path, ownership: 'owned', provenance: ['Saved temporary chat creation: ' + row.session_id], owners: [{ sessionId: row.session_id, kind: 'temporary-chat' }], available: !unavailable.has(row.original_path), directory: true });
      }
    } catch (error) { warnings.push(`${root}: temporary chat records unavailable: ${error.message}`); }
  }

  await visit(root, 'other-storage');
  registerTemporaryChats();

  for (const [name, category] of Object.entries(localCategories)) {
    const target = path.join(root, name);

    if (directories.has(target)) register(category, { path: target, ownership: category === 'unattributed-recovery-storage' ? 'unattributed' : 'owned', provenance: ['Piop profile namespace'], owners: [], available: true, directory: true });
  }

  register('other-storage', { path: root, ownership: 'owned', provenance: ['PIOP_STORAGE_DIRECTORY profile'], owners: [], available: directories.has(root), directory: true });

  for (const record of discovery.recovery.values()) await visitRecovery(record);

  registerQueuedInputs();

  return { sizes, counts, directories, roots, warnings };

}

module.exports = { diskStorage };
