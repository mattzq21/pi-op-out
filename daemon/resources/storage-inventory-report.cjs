const archiveCoverage = 'Logical size of this JSONL transcript. Excludes save files, loop state, attachments, descendant chats, working folders. Other saved files are included in category disk totals where their folders are available. This is not an estimate of freed disk space.';

const diskCoverage = 'Allocated filesystem blocks, including directory metadata, deduplicated by device/inode across this scan. Shared files are charged once to the first category encountered; symbolic-link targets are not traversed.';

const definitions = [
  ['active-conversations', 'conversation', 'owned', 'retained', 'Transcripts and other session files; goal assets are separate. Allocated bytes also include retained publication temporary transcripts in the sessions namespace. Diagnostic publication references do not add live conversation counts.'],
  ['archived-conversations', 'conversation', 'owned', 'requires-owner-check', 'Archived transcripts and other session files; goal assets are separate.'],
  ['temporary-chats', 'directory', 'owned', 'unknown', 'Profile tmp workdirs, including nonempty work and files.'],
  ['recovery-storage', 'recovery', 'owned', 'unknown', 'Recovery containers with verified v1 ownership records, including allocated, ready and published states. State and owners appear per root.'],
  ['unattributed-recovery-storage', 'recovery', 'unattributed', 'unknown', 'Recovery root metadata, loose files and containers without verified ownership; pending artifacts are retained.'],
  ['goal-attachments', 'asset directory', 'shared', 'requires-owner-check', 'Goal objective files and attachments referenced by surviving goal history, including completed goals, forks and verified goalAssets directory contracts. Saved transitive dependency records propagate surviving owners only with matching managed directory identities and source/target claims. Durable claims and retired claim IDs are provenance, not live owner counts. Undeclared legacy text dependencies are outside verified coverage.'],
  ['unattributed-goal-attachments', 'asset directory', 'unattributed', 'unknown', 'Goal asset directories without a verified surviving conversation reference, including roots referenced only by retained transaction backups, publication dependency contracts or exact-digest publication/quarantine transcripts. Planned publication contracts retain every declared directory even without a transcript. Diagnostic references and durable/retired claims are labeled separately and do not establish current liveness. Unreadable or external history may still own these roots; discovery does not authorize cleanup.'],
  ['other-storage', 'file', 'owned', 'unknown', 'Profile settings, databases, caches, logs and uncategorized files, including publication journals, locks, quarantined payloads. Count is observed regular files, not directories or declared journal byte sizes. Namespace and diagnostic provenance do not establish live owners or authorize cleanup.'],
];

function publicRoot(record) {
  const root = { path: record.path, ownership: record.ownership, provenance: record.provenance, owners: record.owners, available: record.available ?? false };

  if (record.state) root.state = record.state;

  return root;
}

function diskCategory(definition, disk, activeCount, archivedCount) {
  const [id, countUnit, ownership, reclaimability, coverage] = definition;
  const roots = [...disk.roots.get(id)?.values() || []].map(publicRoot);
  let itemCount = disk.counts.get(id) || 0;

  if (id === 'active-conversations') itemCount = activeCount;

  if (id === 'archived-conversations') itemCount = archivedCount;

  const directories = [...disk.roots.get(id)?.values() || []].flatMap(root => root.available && root.directory ? [root.path] : []);

  return { id, countUnit, ownership, reclaimability, coverage: `${coverage} ${diskCoverage}`, measurement: 'allocated-blocks', includedInTotal: true, byteSize: disk.sizes.get(id) || 0, itemCount, directories, roots };
}

function inventoryCategories(disk, activeCount, archivedCount) {
  const categories = definitions.map(definition => diskCategory(definition, disk, activeCount, archivedCount));

  return categories;
}

module.exports = { inventoryCategories, archiveCoverage };
