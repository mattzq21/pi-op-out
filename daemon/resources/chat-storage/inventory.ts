import * as stateRecords from '../piop-storage/index.ts';
import * as names from '../piop-storage/index.ts';
import * as database from '../session-database/index.ts';
import { Type } from "typebox";
import { Check } from "typebox/value";
import { validSessionHeader } from "./session-header.ts";
import fs from "node:fs/promises";
import { createReadStream, readdirSync } from "node:fs";
import path from "node:path";
import { lines as lfLines } from "../../src/util/lines.ts";
import * as TemporaryChats from './temporary-chats.ts';

// The storage report: the sizes of the storage folders, and the archived chats. The saved rows say what each file is.

interface ArchiveRow { id: string; path: string; modifiedAt: number; byteSize: number; byteSizeCoverage: string; name: string; cwd: string; deletable: boolean; deleteError?: string; restorable?: boolean }

function messageText(message: any): string {
  if (Check(Type.String(), message?.content)) return message.content;

  if (!Array.isArray(message?.content)) return "";

  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text || "").join("\n");
}

// The header and the first prompt of a transcript.
async function transcriptStart(file: string): Promise<{ header: any; firstPrompt: string }> {
  let header: any;
  const input = createReadStream(file);

  try {
    for await (const line of lfLines(input)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);

      if (!header) { header = entry; continue; }

      if (entry.type === "message" && entry.message?.role === "user") return { header, firstPrompt: messageText(entry.message).trim().slice(0, 2000) };
    }
  } finally { input.destroy(); }

  return { header, firstPrompt: "" };
}

async function archive(root: string, row: any, metadata: any): Promise<ArchiveRow> {
  const saved = { id: row.session_id, path: row.session_path, modifiedAt: Math.floor(metadata.mtimeMs / 1000), byteSize: metadata.size, byteSizeCoverage: archiveCoverage };
  let start: { header: any; firstPrompt: string } | undefined;

  try { start = await transcriptStart(row.session_path); } catch {}

  if (!validSessionHeader(start?.header) || start.header.id !== row.session_id) {
    return { ...saved, name: "Unreadable conversation", cwd: "Unknown project", deletable: false, deleteError: "This archive has invalid chat data." };
  }

  return {
    ...saved, cwd: start.header.cwd,
    name: names.sessionName(row.session_path, row.session_id) || names.promptName(start.firstPrompt) || "Untitled conversation",
    byteSizeCoverage: archiveCoverage + ' Queued messages are stored in the shared database and excluded from this size.',
    deletable: true,
    restorable: !stateRecords.isAuxiliary(stateRecords.records(row.session_path, row.session_id).map(record => record.entry)),
  };
}

// The archived chats, the most recent first; at most limit of them.
async function archivedConversations(root: string, rows: any[], limit: number | undefined, warnings: string[]): Promise<ArchiveRow[]> {
  const dated: Array<{ row: any; metadata: any }> = [];

  for (const row of rows) {
    try { dated.push({ row, metadata: await fs.lstat(row.session_path) }); }
    catch (error) { warnings.push(`${row.session_path}: archived conversation unavailable: ${(error as Error).message}`); }
  }
  dated.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
  const archives: ArchiveRow[] = [];

  for (const { row, metadata } of limit === undefined ? dated : dated.slice(0, limit)) archives.push(await archive(root, row, metadata));

  return archives;
}

async function storageInventory(request: { profile: string; archivesOnly?: boolean; archivesLimit?: number }) {
  if (!Check(Type.String({ minLength: 1 }), request.profile) || !path.isAbsolute(request.profile)) throw new Error('Invalid profile directory');
  const limit = request.archivesLimit;

  if (limit !== undefined && !Check(Type.Integer({ minimum: 1 }), limit)) throw new Error('Invalid archive limit');
  const profile = await fs.realpath(request.profile).catch(() => request.profile);
  const rows = database.inventorySessions(profile);
  const archivedRows = rows.filter(row => row.archived === 1);
  const warnings: string[] = [];
  const archives = await archivedConversations(profile, archivedRows, limit, warnings);

  if (request.archivesOnly === true) return { categories: [], archives, warnings };

  const recovery = recoveryRoots(profile, warnings);
  const archived = new Set(archivedRows.flatMap(row => [row.session_path, row.session_path.replace(/\.jsonl$/, '.snapshots')]));
  const disk = await diskStorage(profile, { archived, recovery });

  return {
    categories: inventoryCategories(disk, rows.length - archivedRows.length, archivedRows.length),
    archives,
    warnings: [...new Set([...warnings, ...disk.warnings])],
  };
}

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
      for (const row of TemporaryChats.list(root)) {
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

const archiveCoverage = 'Logical size of this JSONL transcript. Excludes save files, loop state, attachments, descendant chats, working folders. Other saved files are included in category disk totals where their folders are available. This is not an estimate of freed disk space.';

const definitions = [
  ['active-conversations', 'conversation', 'owned', 'retained'],
  ['archived-conversations', 'conversation', 'owned', 'requires-owner-check'],
  ['temporary-chats', 'directory', 'owned', 'unknown'],
  ['chat-worktrees', 'directory', 'owned', 'unknown'],
  ['recovery-storage', 'recovery', 'owned', 'unknown'],
  ['unattributed-recovery-storage', 'recovery', 'unattributed', 'unknown'],
  ['goal-files', 'file', 'owned', 'unknown'],
  ['other-storage', 'file', 'owned', 'unknown'],
];

function publicRoot(record: StorageRoot) {
  return { path: record.path, ownership: record.ownership, provenance: record.provenance, owners: record.owners, available: record.available ?? false };
}

type DiskStorage = Awaited<ReturnType<typeof diskStorage>>;

function diskCategory(definition: string[], disk: DiskStorage, activeCount: number, archivedCount: number) {
  const [id, countUnit, ownership, reclaimability] = definition;
  const roots = [...disk.roots.get(id)?.values() || []].map(publicRoot);
  let itemCount = disk.counts.get(id) || 0;

  if (id === 'active-conversations') itemCount = activeCount;

  if (id === 'archived-conversations') itemCount = archivedCount;

  const directories = [...disk.roots.get(id)?.values() || []].flatMap(root => root.available && root.directory ? [root.path] : []);

  return { id, countUnit, ownership, reclaimability, measurement: 'allocated-blocks', includedInTotal: true, byteSize: disk.sizes.get(id) || 0, itemCount, directories, roots };
}

function inventoryCategories(disk: DiskStorage, activeCount: number, archivedCount: number) {
  const categories = definitions.map(definition => diskCategory(definition, disk, activeCount, archivedCount));

  return categories;
}

export interface RootOwner { sessionId: string; sessionPath?: string; kind: string }

export interface StorageRoot {
  path: string; ownership: string; owners: RootOwner[];
  provenance: string[]; available?: boolean; directory?: boolean;
}

// The missing-folder recoveries, by folder: recovery/<chat ID> belongs to that chat while it is saved.
function recoveryRoots(profile: string, warnings: string[]): Map<string, StorageRoot> {
  const roots = new Map<string, StorageRoot>();
  const directory = path.join(profile, 'recovery');
  let names: string[];

  try { names = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${directory}: recovery folders unavailable: ${(error as Error).message}`);
    return roots;
  }

  for (const name of names) {
    const saved = database.savedSessionRow(profile, name);

    if (saved) roots.set(path.join(directory, name), { path: path.join(directory, name), ownership: 'owned', provenance: ['Empty folder for a chat whose folder was missing'], owners: [{ sessionId: name, sessionPath: saved.sessionPath, kind: 'recovery-owner' }] });
  }

  return roots;
}

export { storageInventory };
