import * as stateRecords from './piop-storage/session-records.ts';
import * as names from './session-broker/session-names.ts';
import * as database from './session-database.ts';
import { Type } from "typebox";
import { Check } from "typebox/value";
import { validSessionHeader } from "./session-header.ts";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { lines as lfLines } from "./lf-lines.ts";
import { recoveryRoots } from './storage-inventory-roots.ts';
import { diskStorage } from './storage-inventory-disk.ts';
import { inventoryCategories, archiveCoverage } from './storage-inventory-report.ts';

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

export { storageInventory };
