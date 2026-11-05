const stateRecords = require('./piop-storage/session-records.cjs');
const names = require('./session-broker/session-names.cjs');
const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { validSessionHeader } = require("./session-header.cjs");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { lines: lfLines } = require("./lf-lines.cjs");
const { discoverRoots } = require('./storage-inventory-roots.cjs');
const { createObservation, observeEntry, recordSession, resolveOwners, sessionKind } = require('./storage-inventory-owners.cjs');
const { diskStorage } = require('./storage-inventory-disk.cjs');
const { inventoryCategories, archiveCoverage } = require('./storage-inventory-report.cjs');
const { reconcileGoalAssets } = require('./storage-inventory-goals.cjs');
const { discoverGoalDiagnostics } = require('./storage-inventory-diagnostics.cjs');

function messageText(message) {
  if (Check(Type.String(), message?.content)) return message.content;

  if (!Array.isArray(message?.content)) return "";

  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function safeSessionId(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";
}

async function inspectSession(file, archivedId, read, db) {
  const { header, firstPrompt, malformed, result } = await read(file, () => inspectTranscript(file));
  const observed = result;

  if (archivedId === undefined) return observed;

  return archiveDetails(file, archivedId, header, validSessionHeader(header) ? names.sessionName(file, header.id, db) : undefined, firstPrompt, malformed, observed, db);
}

async function inspectTranscript(file) {
  let header;
  let firstPrompt = "";
  let malformed = false;
  let auxiliary = false;
  const observation = createObservation();

  const recordDescription = (entry) => {
    if (!firstPrompt && entry.type === "message" && entry.message?.role === "user") firstPrompt = messageText(entry.message).trim().slice(0, 2000);
  };

  const input = createReadStream(file);

  try {
    for await (const line of lfLines(input)) {
      if (!line.trim()) continue;
      let entry;

      try { entry = JSON.parse(line); } catch { malformed = true; continue; }

      observeEntry(observation, entry);
      if (stateRecords.isAuxiliary([entry])) auxiliary = true;

      if (!header) {
        if (entry.type !== "session") throw new Error("Invalid session header");
        header = entry;
        continue;
      }

      recordDescription(entry);
    }
  } finally { input.destroy(); }

  const result = { ...sessionDetails(header, malformed, observation), auxiliary };

  return { header, firstPrompt, malformed, result };
}

function sessionDetails(header, malformed, observation) {
  return { observation, readable: validSessionHeader(header) && !malformed, fork: Boolean(header?.parentSession), cwd: validSessionHeader(header) ? header.cwd : undefined, sessionId: Check(Type.String(), header?.id) ? safeSessionId(header.id) : undefined };
}

async function archiveDetails(file, id, header, explicitName, firstPrompt, malformed, result, db) {
  const metadata = await fs.lstat(file);
  const validHeader = validSessionHeader(header);
  const deletable = validHeader && !malformed;

  const deleteError = malformed || !validHeader
    ? "This archive has invalid chat data."
    : "";

  const archive = {
    id, path: file, cwd: Check(Type.String(), header?.cwd) ? header.cwd : "Unknown project",
    name: explicitName || names.promptName(firstPrompt) || "Untitled conversation",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size,
    byteSizeCoverage: archiveCoverage + ' Queued messages are stored in the shared database and excluded from this size.',
    deletable,
    restorable: validHeader && !malformed && !result.auxiliary && !stateRecords.isAuxiliary(stateRecords.records(file, header.id, db).map(record => record.entry)),
  };

  if (!deletable) archive.deleteError = deleteError;

  return { ...result, archive };
}

async function collectUnreadableArchive(file, id, archives) {
  let metadata;

  try { metadata = await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }

  archives.push({
    id, path: file,
    name: "Unreadable conversation", cwd: "Unknown project",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size,
    byteSizeCoverage: archiveCoverage,
    deletable: false,
    deleteError: "This archive has invalid chat data.",
  });
}

async function collectSession(piopRoot, candidate, discovery, archives, read, db) {
  try {
    const details = await inspectSession(candidate.file, candidate.archivedId, read, db);
    recordSession(discovery, details, candidate, piopRoot);

    if (!details.readable) discovery.warnings.push(`${candidate.file}: session provenance is incomplete`);

    if (!details.archive) return;

    archives.push(details.archive);
  } catch (error) {
    discovery.warnings.push(`${candidate.file}: conversation provenance unavailable: ${error.message}`);

    if (candidate.archivedId !== undefined) await collectUnreadableArchive(candidate.file, candidate.archivedId, archives);
  }
}

// The saved chats of the profile that are archived, or not.
async function registeredSessions(profile, archived, warnings) {
  try {
    const rows = require('./session-database.cjs').connection(profile)
      .prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL AND archived=?').all(Number(archived));
    const files = rows.map(row => row.session_path);
    const ids = new Map(rows.map(row => [row.session_path, row.session_id]));

    let itemCount = 0;
    const modified = new Map();

    for (const file of files) {
      try {
        const metadata = await fs.lstat(file);
        modified.set(file, metadata.mtimeMs);
        if (metadata.isFile()) itemCount += 1;
      }
      catch (error) { warnings.push(`${file}: conversation file unavailable: ${error.message}`); }
    }

    return { itemCount, files, modified, ids };
  }
  catch (error) {
    warnings.push(`${profile}: conversation discovery unavailable: ${error.message}`);

    return { itemCount: 0, files: [], modified: new Map(), ids: new Map() };
  }
}

async function archivedConversations(piopRoot, profile, limit) {
  const warnings = [];
  const archived = await registeredSessions(profile, true, warnings);
  const archives = [];
  const age = file => archived.modified.get(file) ?? -Infinity;
  const files = limit === undefined ? archived.files : [...archived.files].sort((left, right) => age(right) - age(left)).slice(0, limit);

  await require('./storage-transcript-cache.cjs').withCache(piopRoot, async (read, db) => {
    for (const file of files) {
      try {
        const details = await inspectSession(file, archived.ids.get(file), read, db);

        if (!details.readable) warnings.push(`${file}: session provenance is incomplete`);
        archives.push(details.archive);
      } catch (error) {
        warnings.push(`${file}: conversation provenance unavailable: ${error.message}`);
        await collectUnreadableArchive(file, archived.ids.get(file), archives);
      }
    }
  });
  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);

  return { categories: [], archives, warnings: [...new Set(warnings)] };
}

async function storageInventory(request) {
  if (!Check(Type.String({ minLength: 1 }), request.profile) || !path.isAbsolute(request.profile)) throw new Error('Invalid profile directory');
  const piopRoot = request.profile;
  const profile = await fs.realpath(piopRoot).catch(() => piopRoot);

  const limit = request.archivesLimit;

  if (limit !== undefined && !Check(Type.Integer({ minimum: 1 }), limit)) throw new Error('Invalid archive limit');

  if (request.archivesOnly === true) return archivedConversations(piopRoot, profile, limit);
  const discovery = await discoverRoots(profile);
  discovery.sessions = new Map();
  discovery.headers = new Map();
  discovery.goals = new Map();
  const active = await registeredSessions(profile, false, discovery.warnings);
  const archived = await registeredSessions(profile, true, discovery.warnings);
  const candidates = new Map();

  for (const file of active.files) candidates.set(file, { file, kind: 'active' });

  for (const file of archived.files) candidates.set(file, { file, archivedId: archived.ids.get(file), kind: 'archived' });
  discovery.archived = new Set(archived.files.flatMap(file => [file, file.replace(/\.jsonl$/, '.snapshots')]));

  for (const file of discovery.sessionPaths) {
    if (!candidates.has(file)) candidates.set(file, { file, kind: sessionKind(file, profile) });
  }

  const archives = [];

  await require('./storage-transcript-cache.cjs').withCache(piopRoot, async (read, db) => {
    for (const candidate of candidates.values()) await collectSession(piopRoot, candidate, discovery, archives, read, db);
  });
  resolveOwners(discovery);
  await discoverGoalDiagnostics(profile, discovery);
  await reconcileGoalAssets(profile, discovery);

  const disk = await diskStorage(profile, discovery);
  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);

  return {
    categories: inventoryCategories(disk, active.itemCount, archived.itemCount),
    archives,
    warnings: [...new Set([...discovery.warnings, ...disk.warnings])],
  };
}

module.exports = { storageInventory };
