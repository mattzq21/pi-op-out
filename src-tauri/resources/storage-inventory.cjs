const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { unavailableCheckpoint, promptCheckpoint, snapshotCheckpoint, validSessionHeader } = require("./checkpoint-schemas.cjs");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { execFile } = require("node:child_process");
const { addRoot, discoverRoots } = require('./storage-inventory-roots.cjs');
const { createObservation, observeEntry, recordSession, resolveOwners, sessionKind } = require('./storage-inventory-owners.cjs');
const { diskStorage } = require('./storage-inventory-disk.cjs');
const { checkpointStorage } = require('./storage-inventory-checkpoints.cjs');
const { inventoryCategories, archiveCoverage } = require('./storage-inventory-report.cjs');
const { discoverEphemeral, discoverPendingLogs } = require('./storage-inventory-ephemeral.cjs');
const { reconcileGoalAssets } = require('./storage-inventory-goals.cjs');
const { discoverGoalDiagnostics } = require('./storage-inventory-diagnostics.cjs');
const { sharedArchiveRestore, discoverArchiveResources } = require('./storage-inventory-resources.cjs');

const configuredRoot = process.env.PIOP_STORAGE_DIRECTORY || '.piop';

const piopRoot = path.join(os.homedir(), configuredRoot);

function promptRepository(entry, header) { return entry.data?.repositoryRoot ?? header.checkpointRepositoryRoot ?? header.cwd; }

async function regularFileSize(file) {
  try {
    const metadata = await fs.lstat(file);

    return metadata.isFile() ? metadata.size : 0;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function scanDirectory(directory, countEntry, includeFile = () => true, recursive = true) {
  let itemCount = 0;
  const files = [];

  async function visit(current, topLevel) {
    let entries;

    try { entries = await fs.readdir(current, { withFileTypes: true }); }

    catch (error) { if (error.code === "ENOENT") return; throw error; }

    for (const entry of entries) {
      const target = path.join(current, entry.name);

      if (countEntry(entry, topLevel)) itemCount += 1;

      if (entry.isDirectory() && recursive) await visit(target, false);

      else if (entry.isFile() && includeFile(entry, target)) {
        files.push(target);
      }
    }
  }

  await visit(directory, true);

  return { itemCount, files };

}

function messageText(message) {
  if (Check(Type.String(), message?.content)) return message.content;

  if (!Array.isArray(message?.content)) return "";

  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function safeSessionId(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";
}

function checkpointRepositoryRecord(repositories, root) {
  if (!repositories.has(root)) repositories.set(root, { root, commits: new Set(), expectedRefs: new Map() });

  return repositories.get(root);
}

async function inspectSession(file, includeArchiveDetails) {
  let header;
  let explicitName = "";
  let firstPrompt = "";
  let malformed = false;
  let checkpointError = "";
  const checkpointRepositories = new Map();
  const observation = createObservation();

  const recordSnapshot = (entry) => {
    if (entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot") {
      if (snapshotCheckpoint(entry.data)) {
        const id = Check(Type.String(), header.id) ? safeSessionId(header.id) : "";
        const prefix = `refs/pi-session-snapshots/chats/${id}/`;

        if (id && (entry.data.ref.startsWith(prefix) || entry.data.ref === `refs/pi-session-snapshots/${id}`)) {
          const repository = checkpointRepositoryRecord(checkpointRepositories, entry.data.repositoryRoot);
          repository.commits.add(entry.data.commit);
          repository.expectedRefs.set(entry.data.ref, entry.data.commit);
        }
      }
      else if (!unavailableCheckpoint(entry.data)) checkpointError ||= "This archive contains invalid project snapshot metadata, so checkpoint cleanup cannot be verified.";
    }
  };

  const recordPromptCheckpoint = (entry) => {
    if (entry.type === "custom" && entry.customType === "pi-project-prompt-checkpoint") {
      const cwd = promptRepository(entry, header);

      if (promptCheckpoint(entry.data) && Check(Type.String(), cwd) && path.isAbsolute(cwd) && Check(Type.String(), header.id)) {
        const repository = checkpointRepositoryRecord(checkpointRepositories, cwd);
        repository.commits.add(entry.data.commit);
        repository.expectedRefs.set(`refs/pi-session-snapshots/chats/${safeSessionId(header.id)}/prompts/${entry.data.key}`, entry.data.commit);
      }
      else if (!unavailableCheckpoint(entry.data)) checkpointError ||= "This archive contains invalid prompt checkpoint metadata, so checkpoint cleanup cannot be verified.";
    }
  };

  const recordDescription = (entry) => {
    if (entry.type === "session_info" && Check(Type.String(), entry.name) && entry.name.trim()) explicitName = entry.name.trim().slice(0, 2000);

    if (!firstPrompt && entry.type === "message" && entry.message?.role === "user") firstPrompt = messageText(entry.message).trim().slice(0, 2000);
  };

  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;

      try { entry = JSON.parse(line); } catch { malformed = true; continue; }

      observeEntry(observation, entry);

      if (!header) {
        if (entry.type !== "session") throw new Error("Invalid session header");
        header = entry;
        continue;
      }

      recordDescription(entry);
      recordSnapshot(entry);
      recordPromptCheckpoint(entry);
    }
  } finally { lines.close(); }

  const result = sessionDetails(header, malformed, observation, checkpointRepositories);

  if (!includeArchiveDetails) return result;

  return archiveDetails(file, header, explicitName, firstPrompt, malformed, checkpointError, result);
}

function sessionDetails(header, malformed, observation, repositories) {
  return { observation, readable: validSessionHeader(header) && !malformed, fork: Boolean(header?.parentSession), checkpointRepositories: [...repositories.values()], cwd: validSessionHeader(header) ? header.cwd : undefined, sessionId: Check(Type.String(), header?.id) ? safeSessionId(header.id) : undefined };
}

async function archiveDetails(file, header, explicitName, firstPrompt, malformed, checkpointError, result) {
  const metadata = await fs.lstat(file);
  const diffFile = file.replace(/\.jsonl$/, ".diffs.json");
  const diffBytes = await regularFileSize(diffFile);
  const validHeader = validSessionHeader(header);
  const deletable = validHeader && !malformed && !checkpointError;

  const deleteError = malformed || !validHeader
    ? "This archive is malformed, so piop cannot discover and safely remove its project checkpoint refs."
    : checkpointError;

  const archive = {
    ...archiveLocation(header, file),
    name: explicitName || firstPrompt || "Untitled conversation",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size + diffBytes,
    byteSizeCoverage: archiveCoverage,
    deletable,
    ...await archivedWorktree(header, file),
  };

  if (!deletable) archive.deleteError = deleteError;

  return { ...result, archive };
}

const worktreeChecks = new Map();

function currentWorktree(cwd) {
  if (!worktreeChecks.has(cwd)) worktreeChecks.set(cwd, (async () => {
    try {
      const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
      const common = await fs.realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      const own = await fs.realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());

      return own !== common ? root : null;
    } catch { return undefined; }
  })());

  return worktreeChecks.get(cwd);
}

async function archivedWorktree(header, file) {
  if (!validSessionHeader(header)) return {};

  if (header.archiveResourceId !== undefined) {
    try { return sharedArchiveRestore(await fs.realpath(piopRoot), file, header); }
    catch (error) { return { restorable: false, restoreError: 'Shared archive profile unavailable: ' + error.message }; }
  }

  const current = await currentWorktree(header.cwd);

  if (current === undefined) return restorableWorktree(header.worktreeRestore);

  return current ? { worktreePath: current } : { restorable: true };

}

async function restorableDirectory(saved) {
  try {
    try { await fs.lstat(saved.path);

      return {}; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const stored = await fs.realpath(saved.storedPath);
    const root = await fs.realpath(path.join(piopRoot, 'archived-tmp'));

    if (path.dirname(stored) !== root || !(await fs.lstat(stored)).isDirectory()) return {};

    return { restorable: true };
  } catch (error) { return { restoreError: `Archived directory unavailable: ${error.message}` }; }
}

function hasArchivedDirectory(saved) {
  return saved?.kind === 'directory' && path.isAbsolute(saved.path ?? '') && path.isAbsolute(saved.storedPath ?? '');
}

async function restorableWorktree(saved) {
  if (hasArchivedDirectory(saved)) {
    return restorableDirectory(saved);
  }

  if (!saved || !path.isAbsolute(saved.path ?? '') || !snapshotCheckpoint(saved)) return {};

  try {
    await fs.lstat(saved.path);

    return {};
  } catch (error) { if (error.code !== 'ENOENT') return {}; }

  try {
    if ((await git(saved.repositoryRoot, ['rev-parse', '--verify', saved.ref])).trim() === saved.commit) return { restorable: true };
  } catch { }

  return { restoreError: 'The recovery checkpoint is unavailable.' };

}

function archiveLocation(header, file) {
  return {
    id: Check(Type.String({ minLength: 1 }), header?.id) ? header.id : path.basename(file, ".jsonl"),
    path: file,
    cwd: Check(Type.String(), header?.cwd) ? header.cwd : "Unknown project",
  };
}

function git(cwd, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });

    child.stdin.on("error", () => { });
    child.stdin.end(input);
  });
}

const repositoryChecks = new Map();

function checkpointRepository(cwd) {
  if (!repositoryChecks.has(cwd)) repositoryChecks.set(cwd, (async () => {
    let metadata;

    try { metadata = await fs.stat(cwd); }
    catch (error) {

      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { unavailable: true, error: `Checkpoint repository no longer exists: ${cwd}` };

      return { error: `Checkpoint repository could not be inspected: ${cwd}: ${error.message}` };
    }

    if (!metadata.isDirectory()) return { unavailable: true, error: `Checkpoint repository is no longer a directory: ${cwd}` };

    try {
      const common = await fs.realpath((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());

      return { common };
    } catch (error) {

      if (error.message.startsWith("fatal: not a git repository")) return { unavailable: true, notGit: true, error: `Checkpoint repository is no longer a Git repository: ${cwd}` };

      return { error: `Checkpoint repository could not be inspected: ${cwd}: ${error.message}` };
    }
  })());

  return repositoryChecks.get(cwd);
}

async function checkpointIdentity(sessionId, records) {
  const id = safeSessionId(sessionId);
  const prefix = `refs/pi-session-snapshots/chats/${id}/`;
  const legacy = `refs/pi-session-snapshots/${id}`;
  const repositories = new Map();

  for (const record of records) {
    const available = await checkpointRepository(record.root);

    if (available.error) return available.error;

    if (!repositories.has(available.common)) repositories.set(available.common, { root: available.common, displayRoot: record.root, commits: new Set(), expectedRefs: new Map() });
    const repository = repositories.get(available.common);
    record.commits.forEach((commit) => repository.commits.add(commit));
    record.expectedRefs.forEach((commit, ref) => repository.expectedRefs.set(ref, commit));
  }

  for (const repository of repositories.values()) {
    const error = await verifyCheckpointIdentity(repository, prefix, legacy);

    if (error) return error;
  }

  return "";
}

async function verifyCheckpointIdentity(repository, prefix, legacy) {
  let refs;

  try {
    const output = await git(repository.root, ["for-each-ref", "--format=%(refname) %(objectname)", prefix, legacy]);
    refs = output.trim().split("\n").filter(Boolean).map((line) => {
      const [ref, oid] = line.split(" ");

      return { ref, oid };
    }).filter(({ ref }) => ref.startsWith(prefix) || ref === legacy);
  } catch (error) { return `Checkpoint refs could not be inspected at ${repository.displayRoot}: ${error.message}`; }

  if (!refs.length) return `Checkpoint repository identity cannot be verified at ${repository.displayRoot}: the conversation's refs are missing`;
  const actual = new Map(refs.map(({ ref, oid }) => [ref, oid]));

  for (const [ref, commit] of repository.expectedRefs) {
    if (actual.has(ref) && actual.get(ref) !== commit) return `Checkpoint repository identity cannot be verified at ${repository.displayRoot}: ${ref} no longer points to its recorded commit`;
  }

  if (!refs.some(({ ref, oid }) => repository.expectedRefs.get(ref) === oid || repository.commits.has(oid))) {
    return `Checkpoint repository identity cannot be verified at ${repository.displayRoot}: no conversation ref matches the recorded checkpoint commits`;
  }

  return "";
}

async function collectUnreadableArchive(file, archives) {
  let metadata;

  try { metadata = await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }

  archives.push({
    id: path.basename(file, ".jsonl"), path: file,
    name: "Unreadable conversation", cwd: "Unknown project",
    modifiedAt: Math.floor(metadata.mtimeMs / 1000),
    byteSize: metadata.size + await regularFileSize(file.replace(/\.jsonl$/, ".diffs.json")),
    byteSizeCoverage: archiveCoverage,
    deletable: false,
    deleteError: "This archive is malformed, so piop cannot discover and safely remove its project checkpoint refs.",
  });
}

async function collectSession(candidate, discovery, archives, referencedWorktrees) {
  try {
    const details = await inspectSession(candidate.file, candidate.archived);
    recordSession(discovery, details, candidate);

    if (!details.readable) discovery.warnings.push(`${candidate.file}: session provenance is incomplete`);

    if (details.cwd) {
      const worktree = await currentWorktree(details.cwd);

      if (worktree) addRoot(referencedWorktrees, worktree, `Conversation cwd: ${candidate.file}; ownership not established`, 'referenced', [{ sessionId: details.sessionId, sessionPath: candidate.file, kind: candidate.kind }]);
    }

    if (!details.archive) return;

    if (details.archive.deletable) {
      const problem = await checkpointIdentity(details.archive.id, details.checkpointRepositories);

      if (problem) { details.archive.deletable = false; details.archive.deleteError = `${problem}. Restore or relocate the repository before deleting this archive.`; }
    }

    archives.push(details.archive);
  } catch (error) {
    discovery.warnings.push(`${candidate.file}: conversation provenance unavailable: ${error.message}`);

    if (candidate.archived) await collectUnreadableArchive(candidate.file, archives);
  }
}

async function scanSessions(root, warnings) {
  try { return await scanDirectory(root, entry => entry.isFile() && entry.name.endsWith('.jsonl'), entry => entry.name.endsWith('.jsonl')); }
  catch (error) {
    warnings.push(`${root}: conversation discovery unavailable: ${error.message}`);

    return { itemCount: 0, files: [] };
  }
}

async function main() {
  const profile = await fs.realpath(piopRoot).catch(() => piopRoot);
  const discovery = await discoverRoots(profile);
  await discoverEphemeral(profile, discovery);
  discovery.sessions = new Map();
  discovery.headers = new Map();
  discovery.goals = new Map();
  const activeRoot = path.join(profile, 'sessions');
  const archiveRoot = path.join(profile, 'archived');
  const active = await scanSessions(activeRoot, discovery.warnings);
  const archived = await scanSessions(archiveRoot, discovery.warnings);
  const candidates = new Map();

  for (const file of active.files) candidates.set(file, { file, archived: false, kind: 'active' });

  for (const file of archived.files) candidates.set(file, { file, archived: true, kind: 'archived' });

  for (const file of discovery.sessionPaths) {
    if (!candidates.has(file)) candidates.set(file, { file, archived: false, kind: discovery.ephemeralRecords.has(file) ? 'ephemeral' : sessionKind(file, profile) });
  }

  const archives = [];
  const referencedWorktrees = new Map();

  for (const candidate of candidates.values()) await collectSession(candidate, discovery, archives, referencedWorktrees);
  resolveOwners(discovery);
  discoverPendingLogs(profile, discovery);
  await discoverGoalDiagnostics(profile, discovery);
  await discoverArchiveResources(profile, discovery);
  await reconcileGoalAssets(profile, discovery);

  for (const record of discovery.cwds.values()) {
    const worktree = await currentWorktree(record.path);

    if (worktree) addRoot(referencedWorktrees, worktree, record.provenance.join('; '), 'referenced', record.owners);
  }

  const disk = await diskStorage(profile, discovery, referencedWorktrees, git);
  const checkpoints = await checkpointStorage(discovery, disk.directories, checkpointRepository, git);
  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);
  process.stdout.write(JSON.stringify({
    categories: inventoryCategories(disk, checkpoints, active.itemCount, archived.itemCount),
    archives,
    warnings: [...new Set([...discovery.warnings, ...disk.warnings, ...checkpoints.warnings])],
  }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
