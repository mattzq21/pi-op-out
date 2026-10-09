const archiveCoverage = 'Logical size of this JSONL transcript plus any retained legacy .diffs.json file. Change history in SQLite is included in shared database bytes and excluded from this size. Excludes snapshot sidecars, loop state, attachments, descendant chats, workdirs, global pending comparison snapshots, staged diff transfer files and shared Git refs. Other retained artifacts are included in category disk totals where their roots are available. This is not an estimate of freed disk space.';

const diskCoverage = 'Allocated filesystem blocks, including directory metadata, deduplicated by device/inode across this scan. Shared files are charged once to the first category encountered; symbolic-link targets are not traversed.';

const checkpointCoverage = 'Estimate of on-disk Git objects reachable only through Piop checkpoint refs, excluding ordinary refs and HEAD. Objects shared across checkpoint groups are charged to active, then unattributed, then archived. Objects inside measured directory trees are already included there. Ref removal may free less space, particularly in packs.';

const definitions = [
  ['active-conversations', 'conversation', 'owned', 'retained', 'Transcripts, diff histories and other session sidecars; snapshot trees and goal assets are separate. Allocated bytes also include retained publication temporary transcripts and declared sidecars in the sessions namespace. Diagnostic publication references do not add live conversation counts.'],
  ['archived-conversations', 'conversation', 'owned', 'requires-owner-check', 'Archived transcripts, diff histories and other session sidecars; snapshot trees and goal assets are separate.'],
  ['git-diff-snapshots', 'snapshot', 'owned', 'retained', 'Global diff baselines and active conversation .snapshots trees, excluding roots attributed to pending comparisons.'],
  ['pending-diff-snapshots', 'snapshot', 'shared', 'unknown', 'Global comparison roots referenced by committed pending diff logs or database recovery records. These must remain available until recovery succeeds; permanent limits and unavailable roots remain visible.'],
  ['diff-transfer-staging', 'stage file', 'owned', 'unknown', 'Private staged diff files matched to validated committed transfer ownership/progress records in their source conversation logs, plus git-diff-transfers directory metadata. Unfinished transfers and committed files awaiting retirement remain retained. Transfer contents stored in SQLite are included in shared database bytes. Counts here are retained legacy stage files, not database records; completed records with absent files contribute no stage count. Missing recorded stages and bytes beyond durable progress are reported.'],
  ['unattributed-diff-transfer-staging', 'stage file', 'unattributed', 'unknown', 'Files in git-diff-transfers without proven matching source-log owners or stable private file identity. Includes unmatched files, copied/conflicting owner provenance and unavailable recorded stages. Counts are observed regular files; unavailable stages contribute no observed count. Names and discovery do not authorize cleanup.'],
  ['archived-git-diff-snapshots', 'snapshot', 'owned', 'requires-owner-check', 'Archived conversation .snapshots trees.'],
  ['temporary-chats', 'directory', 'owned', 'unknown', 'Profile tmp workdirs, including nonempty work and files.'],
  ['worktrees', 'worktree', 'owned', 'unknown', 'Working copies in the Piop allocation namespace and their linked Git administration directories, including build outputs.'],
  ['archived-worktrees', 'directory', 'owned', 'requires-owner-check', 'Retained profile archived-tmp workdirs, including shared resource ledger copies. Stored directory identities and declared digests appear as provenance; unchanged content is not inferred from a ledger alone. Surviving conversations can share copies, which remain protected until the last owner is deleted.'],
  ['recovery-storage', 'recovery', 'owned', 'unknown', 'Recovery containers with verified v1 ownership records, including allocated, ready and published states. State and owners appear per root.'],
  ['unattributed-recovery-storage', 'recovery', 'unattributed', 'unknown', 'Recovery root metadata, loose files and containers without verified ownership; pending artifacts are retained.'],
  ['legacy-recovery-storage', 'directory', 'unattributed', 'unknown', 'Legacy /tmp recovery candidates and sources retained after migration. Names and conversation references do not prove exclusive profile ownership.'],
  ['chatgpt-storage', 'chat', 'shared', 'unknown', 'Pi auth-directory piop-chatgpt storage across all saved accounts, including transcripts, locks, device IDs and temporary files; may be shared by profiles/daemons. Counts use database chat records. Older chat files are imported once.'],
  ['goal-attachments', 'asset directory', 'shared', 'requires-owner-check', 'Goal objective files and attachments referenced by surviving goal history, including completed goals, forks and verified goalAssets directory contracts. Saved transitive dependency records propagate surviving owners only with matching managed directory identities and source/target claims. Durable claims and retired claim IDs are provenance, not live owner counts. Undeclared legacy text dependencies are outside verified coverage.'],
  ['unattributed-goal-attachments', 'asset directory', 'unattributed', 'unknown', 'Goal asset directories without a verified surviving conversation reference, including roots referenced only by retained transaction backups, publication dependency contracts or exact-digest publication/quarantine transcripts. Planned publication contracts retain every declared directory even without a transcript. Diagnostic references and durable/retired claims are labeled separately and do not establish current liveness. Unreadable or external history may still own these roots; discovery does not authorize cleanup.'],
  ['other-storage', 'file', 'owned', 'unknown', 'Profile settings, databases, caches, logs and uncategorized files, including publication journals, locks, quarantined payloads and shared archive resource ledgers. Count is observed regular files, not directories or declared journal byte sizes. Namespace and diagnostic provenance do not establish live owners or authorize cleanup. Shared resource Git pins outside measured directory trees are reported as incomplete coverage rather than zero bytes.'],
  ['referenced-worktrees', 'worktree', 'referenced', 'unknown', 'Cwd/registry-referenced user worktrees and their Git administration files. Ownership is not established; excluded from the Piop total. Bytes are additional blocks not already counted elsewhere.'],
];

function publicRoot(record) {
  const root = { path: record.path, ownership: record.ownership, provenance: record.provenance, owners: record.owners, available: record.available ?? false };

  if (record.state) root.state = record.state;

  if (record.refs) root.refs = record.refs;

  return root;
}

function diskCategory(definition, disk, activeCount, archivedCount) {
  const [id, countUnit, ownership, reclaimability, coverage] = definition;
  const roots = [...disk.roots.get(id)?.values() || []].map(publicRoot);
  let itemCount = disk.counts.get(id) || 0;

  if (id === 'active-conversations') itemCount = activeCount;

  if (id === 'archived-conversations') itemCount = archivedCount;

  const directories = [...disk.roots.get(id)?.values() || []].flatMap(root => root.available && root.directory ? [root.path] : []);

  return { id, countUnit, ownership, reclaimability, coverage: `${coverage} ${diskCoverage}`, measurement: 'allocated-blocks', includedInTotal: id !== 'referenced-worktrees', byteSize: disk.sizes.get(id) || 0, itemCount, directories, roots };
}

function inventoryCategories(disk, checkpoints, activeCount, archivedCount) {
  const categories = definitions.map(definition => diskCategory(definition, disk, activeCount, archivedCount));

  for (const category of checkpoints.categories.values()) {
    categories.push({ ...category, roots: category.roots.map(publicRoot), countUnit: 'ref', ownership: category.id === 'unattributed-project-checkpoints' ? 'unattributed' : 'shared', reclaimability: category.id === 'project-checkpoints' ? 'retained' : 'unknown', coverage: checkpointCoverage, measurement: 'git-object-estimate', estimated: true, includedInTotal: true });
  }

  return categories;
}

module.exports = { inventoryCategories, archiveCoverage };
