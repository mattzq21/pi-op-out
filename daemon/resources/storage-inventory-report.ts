import type { RootOwner } from './storage-inventory-roots.ts';

const archiveCoverage = 'Logical size of this JSONL transcript. Excludes save files, loop state, attachments, descendant chats, working folders. Other saved files are included in category disk totals where their folders are available. This is not an estimate of freed disk space.';

const definitions = [
  ['active-conversations', 'conversation', 'owned', 'retained'],
  ['archived-conversations', 'conversation', 'owned', 'requires-owner-check'],
  ['temporary-chats', 'directory', 'owned', 'unknown'],
  ['chat-worktrees', 'directory', 'owned', 'unknown'],
  ['recovery-storage', 'recovery', 'owned', 'unknown'],
  ['unattributed-recovery-storage', 'recovery', 'unattributed', 'unknown'],
  ['goal-attachments', 'asset directory', 'shared', 'requires-owner-check'],
  ['unattributed-goal-attachments', 'asset directory', 'unattributed', 'unknown'],
  ['other-storage', 'file', 'owned', 'unknown'],
];

function publicRoot(record) {
  const root: { path: string; ownership: string; provenance: string[]; owners: RootOwner[]; available: boolean; state?: string } = { path: record.path, ownership: record.ownership, provenance: record.provenance, owners: record.owners, available: record.available ?? false };

  if (record.state) root.state = record.state;

  return root;
}

function diskCategory(definition, disk, activeCount, archivedCount) {
  const [id, countUnit, ownership, reclaimability] = definition;
  const roots = [...disk.roots.get(id)?.values() || []].map(publicRoot);
  let itemCount = disk.counts.get(id) || 0;

  if (id === 'active-conversations') itemCount = activeCount;

  if (id === 'archived-conversations') itemCount = archivedCount;

  const directories = [...disk.roots.get(id)?.values() || []].flatMap(root => root.available && root.directory ? [root.path] : []);

  return { id, countUnit, ownership, reclaimability, measurement: 'allocated-blocks', includedInTotal: true, byteSize: disk.sizes.get(id) || 0, itemCount, directories, roots };
}

function inventoryCategories(disk, activeCount, archivedCount) {
  const categories = definitions.map(definition => diskCategory(definition, disk, activeCount, archivedCount));

  return categories;
}

export { inventoryCategories, archiveCoverage };
