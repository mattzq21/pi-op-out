const stateRecords = require('./piop-storage/session-records.cjs');
const names = require('./session-broker/session-names.cjs');
const database = require('./session-database.cjs');
const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { validSessionHeader } = require("./session-header.cjs");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { lines: lfLines } = require("./lf-lines.cjs");
const { recoveryRoots } = require('./storage-inventory-roots.cjs');
const { diskStorage } = require('./storage-inventory-disk.cjs');
const { inventoryCategories, archiveCoverage } = require('./storage-inventory-report.cjs');

// The storage report: the sizes of the storage folders, and the archived chats. The saved rows say what each file is.

function messageText(message) {
  if (Check(Type.String(), message?.content)) return message.content;

  if (!Array.isArray(message?.content)) return "";

  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

// The header and the first prompt of a transcript.
async function transcriptStart(file) {
  let header;
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

async function archive(db, row, metadata) {
  const saved = { id: row.session_id, path: row.session_path, modifiedAt: Math.floor(metadata.mtimeMs / 1000), byteSize: metadata.size, byteSizeCoverage: archiveCoverage };
  let start;

  try { start = await transcriptStart(row.session_path); } catch {}

  if (!validSessionHeader(start?.header) || start.header.id !== row.session_id) {
    return { ...saved, name: "Unreadable conversation", cwd: "Unknown project", deletable: false, deleteError: "This archive has invalid chat data." };
  }

  return {
    ...saved, cwd: start.header.cwd,
    name: names.nameOf(db, row.session_id) || names.promptName(start.firstPrompt) || "Untitled conversation",
    byteSizeCoverage: archiveCoverage + ' Queued messages are stored in the shared database and excluded from this size.',
    deletable: true,
    restorable: !stateRecords.isAuxiliary(stateRecords.records(row.session_path, row.session_id, db).map(record => record.entry)),
  };
}

// The archived chats, the most recent first; at most limit of them.
async function archivedConversations(db, rows, limit, warnings) {
  const dated = [];

  for (const row of rows) {
    try { dated.push({ row, metadata: await fs.lstat(row.session_path) }); }
    catch (error) { warnings.push(`${row.session_path}: archived conversation unavailable: ${error.message}`); }
  }
  dated.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
  const archives = [];

  for (const { row, metadata } of limit === undefined ? dated : dated.slice(0, limit)) archives.push(await archive(db, row, metadata));

  return archives;
}

async function storageInventory(request) {
  if (!Check(Type.String({ minLength: 1 }), request.profile) || !path.isAbsolute(request.profile)) throw new Error('Invalid profile directory');
  const limit = request.archivesLimit;

  if (limit !== undefined && !Check(Type.Integer({ minimum: 1 }), limit)) throw new Error('Invalid archive limit');
  const profile = await fs.realpath(request.profile).catch(() => request.profile);
  const db = database.connection(profile);
  const rows = db.prepare('SELECT session_id, session_path, archived FROM sessions WHERE session_path IS NOT NULL').all();
  const archivedRows = rows.filter(row => row.archived === 1);
  const warnings = [];
  const archives = await archivedConversations(db, archivedRows, limit, warnings);

  if (request.archivesOnly === true) return { categories: [], archives, warnings };

  if (database.cleanupRequest(profile, 'temporary-chat') !== undefined) warnings.push('Temporary folder cleanup for deleted sessions is pending');
  const recovery = recoveryRoots(profile, warnings);
  const archived = new Set(archivedRows.flatMap(row => [row.session_path, row.session_path.replace(/\.jsonl$/, '.snapshots')]));
  const disk = await diskStorage(profile, { archived, recovery });

  return {
    categories: inventoryCategories(disk, rows.length - archivedRows.length, archivedRows.length),
    archives,
    warnings: [...new Set([...warnings, ...disk.warnings])],
  };
}

module.exports = { storageInventory };
