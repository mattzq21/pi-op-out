const stateRecords = require('./piop-storage/session-records.cjs');
const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { validSessionHeader } = require("./session-header.cjs");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
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

async function inspectSession(file, includeArchiveDetails, read) {
  const { header, firstPrompt, malformed, result } = await read(file, () => inspectTranscript(file));
  const observed = result;

  if (!includeArchiveDetails) return observed;

  return archiveDetails(file, header, validSessionHeader(header) ? stateRecords.sessionName(file, header.id) : undefined, firstPrompt, malformed, observed);
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

  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  try {
    for await (const line of lines) {
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
  } finally { lines.close(); }

  const result = { ...sessionDetails(header, malformed, observation), auxiliary };

  return { header, firstPrompt, malformed, result };
}

function sessionDetails(header, malformed, observation) {
  return { observation, readable: validSessionHeader(header) && !malformed, fork: Boolean(header?.parentSession), cwd: validSessionHeader(header) ? header.cwd : undefined, sessionId: Check(Type.String(), header?.id) ? safeSessionId(header.id) : undefined };
}

async function archiveDetails(file, header, explicitName, firstPrompt, malformed, result) {
  const metadata = await fs.lstat(file);
  const validHeader = validSessionHeader(header);
  const deletable = validHeader && !malformed;

  const deleteError = malformed || !validHeader
    ? "This archive has invalid chat data."
    : "";

  const archive = {
    ...archiveLocation(header, file),
    name: explicitName || firstPrompt || "Untitled conversation",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size,
    byteSizeCoverage: archiveCoverage + ' Queued messages are stored in the shared database and excluded from this size.',
    deletable,
    restorable: validHeader && !malformed && !result.auxiliary && !stateRecords.isAuxiliary(stateRecords.records(file, header.id).map(record => record.entry)),
  };

  if (!deletable) archive.deleteError = deleteError;

  return { ...result, archive };
}

function archiveLocation(header, file) {
  return {
    id: Check(Type.String({ minLength: 1 }), header?.id) ? header.id : path.basename(file, ".jsonl"),
    path: file,
    cwd: Check(Type.String(), header?.cwd) ? header.cwd : "Unknown project",
  };
}

async function collectUnreadableArchive(file, archives) {
  let metadata;

  try { metadata = await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }

  archives.push({
    id: path.basename(file, ".jsonl"), path: file,
    name: "Unreadable conversation", cwd: "Unknown project",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size,
    byteSizeCoverage: archiveCoverage,
    deletable: false,
    deleteError: "This archive has invalid chat data.",
  });
}

async function collectSession(piopRoot, candidate, discovery, archives, read) {
  try {
    const details = await inspectSession(candidate.file, candidate.archived, read);
    recordSession(discovery, details, candidate, piopRoot);

    if (!details.readable) discovery.warnings.push(`${candidate.file}: session provenance is incomplete`);

    if (!details.archive) return;

    archives.push(details.archive);
  } catch (error) {
    discovery.warnings.push(`${candidate.file}: conversation provenance unavailable: ${error.message}`);

    if (candidate.archived) await collectUnreadableArchive(candidate.file, archives);
  }
}

async function registeredSessions(root, warnings) {
  try {
    const files = require('./session-database.cjs').paths(path.dirname(root), root).filter(file => {
      const relative = path.relative(root, file);

      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && file.endsWith('.jsonl');
    });

    let itemCount = 0;

    for (const file of files) {
      try { if ((await fs.lstat(file)).isFile()) itemCount += 1; }
      catch (error) { warnings.push(`${file}: conversation file unavailable: ${error.message}`); }
    }

    return { itemCount, files };
  }
  catch (error) {
    warnings.push(`${root}: conversation discovery unavailable: ${error.message}`);

    return { itemCount: 0, files: [] };
  }
}

/** Reports storage use and archived conversations of the profile at request.profile. */
async function storageInventory(request) {
  if (!Check(Type.String({ minLength: 1 }), request.profile) || !path.isAbsolute(request.profile)) throw new Error('Invalid profile directory');
  const piopRoot = request.profile;
  const profile = await fs.realpath(piopRoot).catch(() => piopRoot);
  const discovery = await discoverRoots(profile);
  discovery.sessions = new Map();
  discovery.headers = new Map();
  discovery.goals = new Map();
  const activeRoot = path.join(profile, 'sessions');
  const archiveRoot = path.join(profile, 'archived');
  const active = await registeredSessions(activeRoot, discovery.warnings);
  const archived = await registeredSessions(archiveRoot, discovery.warnings);
  const candidates = new Map();

  for (const file of active.files) candidates.set(file, { file, archived: false, kind: 'active' });

  for (const file of archived.files) candidates.set(file, { file, archived: true, kind: 'archived' });

  for (const file of discovery.sessionPaths) {
    if (!candidates.has(file)) candidates.set(file, { file, archived: false, kind: sessionKind(file, profile) });
  }

  const archives = [];

  await require('./storage-transcript-cache.cjs').withCache(piopRoot, async read => {
    for (const candidate of candidates.values()) await collectSession(piopRoot, candidate, discovery, archives, read);
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
