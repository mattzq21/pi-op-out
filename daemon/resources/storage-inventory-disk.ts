import fs from 'node:fs/promises';
import path from 'node:path';
import * as TemporaryChatInventory from './temporary-chat-inventory.ts';

const localCategories: Record<string, string> = { sessions: 'active-conversations', tmp: 'temporary-chats', worktrees: 'chat-worktrees', recovery: 'unattributed-recovery-storage', 'goal-files': 'goal-files' };

// The sizes of the storage folders by category: a walk of the profile folder. The saved rows (discovery) say which
// transcripts are archived and which recovery folders belong to a chat.
function specialCategory(target: string, category: string, metadata: any, discovery: any): string {
  if (category === 'active-conversations' && discovery.archived?.has(target)) return 'archived-conversations';

  if (!metadata.isDirectory()) return category;

  if (discovery.recovery.has(target)) return 'recovery-storage';

  return category;
}

async function diskStorage(profile: string, discovery: any) {
  const sizes = new Map<string, number>();
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const directories = new Set<string>();
  const roots = new Map<string, Map<string, any>>();
  const warnings: string[] = [];
  const unavailable = new Set<string>();
  const root = await fs.realpath(profile).catch(() => profile);

  function addCount(category: string, amount = 1) { counts.set(category, (counts.get(category) || 0) + amount); }

  function register(category: string, record: any) {
    if (!roots.has(category)) roots.set(category, new Map());
    roots.get(category)!.set(record.path, record);
  }

  function countDirectory(target: string, category: string, entries: any[]) {
    if (category === 'chat-worktrees' && target === path.join(root, 'worktrees')) addCount(category, entries.filter(entry => entry.isDirectory()).length);

    if (category === 'other-storage') addCount(category, entries.filter(entry => entry.isFile()).length);

    if (category === 'goal-files' && target === path.join(root, 'goal-files')) addCount(category, entries.filter(entry => entry.isFile()).length);
  }

  async function visit(target: string, category: string, required = false): Promise<void> {
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

      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${target}: storage unavailable: ${(error as Error).message}`);
    }
  }

  function childCategory(target: string, name: string, category: string): string {
    return target === root ? localCategories[name] || 'other-storage' : category;
  }

  async function visitRecord(category: string, record: any): Promise<void> {
    register(category, record);

    try {
      const metadata = await fs.lstat(record.path);
      await visit(record.path, category, true);
      record.available = !unavailable.has(record.path);
      record.directory = metadata.isDirectory();
    } catch (error) { record.available = false; warnings.push(`${record.path}: storage unavailable: ${(error as Error).message}`); }
  }

  async function visitRecovery(record: any): Promise<void> {
    addCount('recovery-storage');
    await visitRecord('recovery-storage', record);
  }

  function registerTemporaryChats(): void {
    try {
      for (const row of TemporaryChatInventory.list(root)) {
        if (!directories.has(row.original_path)) continue;
        addCount('temporary-chats');
        register('temporary-chats', { path: row.original_path, ownership: 'owned', provenance: ['Saved temporary chat creation: ' + row.session_id], owners: [{ sessionId: row.session_id, kind: 'temporary-chat' }], available: !unavailable.has(row.original_path), directory: true });
      }
    } catch (error) { warnings.push(`${root}: temporary chat records unavailable: ${(error as Error).message}`); }
  }

  await visit(root, 'other-storage');
  registerTemporaryChats();

  for (const [name, category] of Object.entries(localCategories)) {
    const target = path.join(root, name);

    if (directories.has(target)) register(category, { path: target, ownership: category === 'unattributed-recovery-storage' ? 'unattributed' : 'owned', provenance: ['Piop profile namespace'], owners: [], available: true, directory: true });
  }

  register('other-storage', { path: root, ownership: 'owned', provenance: ['PIOP_STORAGE_DIRECTORY profile'], owners: [], available: directories.has(root), directory: true });

  for (const record of discovery.recovery.values()) await visitRecovery(record);

  return { sizes, counts, directories, roots, warnings };
}

export { diskStorage };
