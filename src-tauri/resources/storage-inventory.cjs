const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { execFile } = require("node:child_process");

const piopRoot = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
const sessionRoots = [path.join(piopRoot, "sessions"), path.join(piopRoot, "archived")];
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

async function scanDirectory(directory, countEntry, includeFile = () => true) {
  let byteSize = 0;
  let itemCount = 0;
  const files = [];
  async function visit(current, topLevel) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (countEntry(entry, topLevel)) itemCount += 1;
      if (entry.isDirectory()) await visit(target, false);
      else if (entry.isFile() && includeFile(entry, target)) {
        byteSize += await regularFileSize(target);
        files.push(target);
      }
    }
  }
  await visit(directory, true);
  return { byteSize, itemCount, files };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function unavailableCheckpoint(data) {
  return data && typeof data === "object" && data.unavailable === true;
}

function promptCheckpoint(data) {
  return data && typeof data === "object"
    && typeof data.key === "string" && /^[a-zA-Z0-9-]+$/.test(data.key)
    && typeof data.owner === "string"
    && typeof data.commit === "string" && /^[a-f0-9]{40,64}$/.test(data.commit)
    && (data.base === null || (typeof data.base === "string" && /^[a-f0-9]{40,64}$/.test(data.base)));
}

function snapshotCheckpoint(data) {
  return data && typeof data === "object"
    && typeof data.repositoryRoot === "string" && path.isAbsolute(data.repositoryRoot)
    && typeof data.ref === "string" && data.ref.startsWith("refs/pi-session-snapshots/") && !/[\r\n]/.test(data.ref)
    && typeof data.commit === "string" && /^[a-f0-9]{40,64}$/.test(data.commit);
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
  const recordSnapshot = (entry) => {
    if (entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot") {
      if (snapshotCheckpoint(entry.data)) {
        const id = typeof header.id === "string" ? safeSessionId(header.id) : "";
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
      if (promptCheckpoint(entry.data) && typeof cwd === "string" && path.isAbsolute(cwd) && typeof header.id === "string") {
        const repository = checkpointRepositoryRecord(checkpointRepositories, cwd);
        repository.commits.add(entry.data.commit);
        repository.expectedRefs.set(`refs/pi-session-snapshots/chats/${safeSessionId(header.id)}/prompts/${entry.data.key}`, entry.data.commit);
      }
      else if (!unavailableCheckpoint(entry.data)) checkpointError ||= "This archive contains invalid prompt checkpoint metadata, so checkpoint cleanup cannot be verified.";
    }
  };
  const recordDescription = (entry) => {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) explicitName = entry.name.trim().slice(0, 2000);
    if (!firstPrompt && entry.type === "message" && entry.message?.role === "user") firstPrompt = messageText(entry.message).trim().slice(0, 2000);
  };
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { malformed = true; continue; }
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
  const result = { checkpointRepositories: [...checkpointRepositories.values()] };
  if (!includeArchiveDetails) return result;
  return archiveDetails(file, header, explicitName, firstPrompt, malformed, checkpointError, result);
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
  return {
    ...result,
    archive: {
      ...archiveLocation(header, file),
      name: explicitName || firstPrompt || "Untitled conversation",
      modifiedAt: Math.floor(metadata.mtimeMs / 1000),
      byteSize: metadata.size + diffBytes,
      deletable,
      ...await archivedWorktree(header),
      ...(deletable ? {} : { deleteError }),
    },
  };
}

async function archivedWorktree(header) {
  if (!validSessionHeader(header)) return {};
  try {
    const root = (await git(header.cwd, ['rev-parse', '--show-toplevel'])).trim();
    const common = await fs.realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const own = await fs.realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
    return own !== common ? { worktreePath: root } : {};
  } catch {
    return restorableWorktree(header.worktreeRestore);
  }
}

async function restorableWorktree(saved) {
    if (!saved || !path.isAbsolute(saved.path ?? '') || !snapshotCheckpoint(saved)) return {};
    try {
      await fs.lstat(saved.path);
      return {};
    } catch (error) { if (error.code !== 'ENOENT') return {}; }
    try {
      if ((await git(saved.repositoryRoot, ['rev-parse', '--verify', saved.ref])).trim() === saved.commit) return { restorable: true };
    } catch { }
    return { restoreError: 'The last response checkpoint is unavailable.' };
}

function archiveLocation(header, file) {
  return {
    id: typeof header?.id === "string" && header.id ? header.id : path.basename(file, ".jsonl"),
    path: file,
    cwd: typeof header?.cwd === "string" ? header.cwd : "Unknown project",
  };
}

function validSessionHeader(header) { return header?.type === "session" && typeof header.id === "string" && Boolean(header.id) && typeof header.cwd === "string" && path.isAbsolute(header.cwd); }

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
      if (error.code === "ENOENT") return { error: `Checkpoint repository no longer exists: ${cwd}` };
      return { error: `Checkpoint repository could not be inspected: ${cwd}: ${error.message}` };
    }
    if (!metadata.isDirectory()) return { error: `Checkpoint repository is no longer a directory: ${cwd}` };
    try {
      const common = await fs.realpath((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
      return { common };
    } catch (error) {
      if (error.message.startsWith("fatal: not a git repository")) return { error: `Checkpoint repository is no longer a Git repository: ${cwd}` };
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
      const [ref, oid] = line.split(" "); return { ref, oid };
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

async function checkpointStorage(repositoryRoots) {
  const repositories = new Set();
  let byteSize = 0;
  let itemCount = 0;
  const warnings = [];
  for (const cwd of repositoryRoots) {
    try {
      const repository = await checkpointRepository(cwd);
      if (repository.error) { warnings.push(repository.error); continue; }
      const common = repository.common;
      if (repositories.has(common)) continue;
      repositories.add(common);
      const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)"])).trim().split("\n").filter(Boolean);
      const snapshots = refs.filter((ref) => ref === "refs/pi-session-snapshots" || ref.startsWith("refs/pi-session-snapshots/"));
      if (!snapshots.length) continue;
      itemCount += snapshots.length;
      const ordinary = refs.filter((ref) => !snapshots.includes(ref)).map((ref) => `^${ref}`);
      try { await git(cwd, ["rev-parse", "--verify", "HEAD"]); ordinary.push("^HEAD"); } catch { }
      const revisions = `${snapshots.join("\n")}\n${ordinary.join("\n")}\n`;
      const objects = [...new Set((await git(cwd, ["rev-list", "--objects", "--stdin"], revisions)).trim().split("\n").filter(Boolean).map((line) => line.split(" ", 1)[0]))];
      if (!objects.length) continue;
      const sizes = await git(cwd, ["cat-file", "--batch-check=%(objectsize:disk)"], `${objects.join("\n")}\n`);
      for (const value of sizes.trim().split("\n")) if (/^\d+$/.test(value)) byteSize += Number(value);
    } catch (error) {
      warnings.push(`${cwd}: ${error.message}`);
    }
  }
  return { byteSize, itemCount, warnings };
}

async function main() {
  const activeRoot = sessionRoots[0];
  const archiveRoot = sessionRoots[1];
  const [active, archived, gitDiffSnapshots, temporaryChats] = await Promise.all([
    scanDirectory(activeRoot, (entry) => entry.isFile() && entry.name.endsWith(".jsonl"), (entry) => entry.name.endsWith(".jsonl") || entry.name.endsWith(".diffs.json")),
    scanDirectory(archiveRoot, (entry) => entry.isFile() && entry.name.endsWith(".jsonl"), (entry) => entry.name.endsWith(".jsonl") || entry.name.endsWith(".diffs.json")),
    scanDirectory(path.join(piopRoot, "git-snapshots"), (entry, topLevel) => topLevel && entry.isDirectory() && entry.name.startsWith("pi-desktop-diff-")),
    scanDirectory(path.join(piopRoot, "tmp"), (entry, topLevel) => topLevel && entry.isDirectory()),
  ]);
  const checkpointRoots = new Set();
  const archives = [];
  const sessionFiles = [
    ...active.files.filter((file) => file.endsWith(".jsonl")).map((file) => ({ file, archived: false })),
    ...archived.files.filter((file) => file.endsWith(".jsonl")).map((file) => ({ file, archived: true })),
  ];
  for (const candidate of sessionFiles) {
    try {
      const details = await inspectSession(candidate.file, candidate.archived);
      details.checkpointRepositories.forEach((repository) => checkpointRoots.add(repository.root));
      if (details.archive) {
        if (details.archive.deletable) {
          const problem = await checkpointIdentity(details.archive.id, details.checkpointRepositories);
          if (problem) { details.archive.deletable = false; details.archive.deleteError = `${problem}. Restore or relocate the repository before deleting this archive.`; }
        }
        archives.push(details.archive);
      }
    } catch {
      if (candidate.archived) {
        let metadata;
        try { metadata = await fs.lstat(candidate.file); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        archives.push({
          id: path.basename(candidate.file, ".jsonl"), path: candidate.file,
          name: "Unreadable conversation", cwd: "Unknown project",
          modifiedAt: Math.floor(metadata.mtimeMs / 1000),
          byteSize: metadata.size + await regularFileSize(candidate.file.replace(/\.jsonl$/, ".diffs.json")),
          deletable: false,
          deleteError: "This archive is malformed, so piop cannot discover and safely remove its project checkpoint refs.",
        });
      }
    }
  }
  const checkpoints = await checkpointStorage(checkpointRoots);
  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);
  process.stdout.write(JSON.stringify({
    categories: [
      { id: "active-conversations", byteSize: active.byteSize, itemCount: active.itemCount },
      { id: "archived-conversations", byteSize: archived.byteSize, itemCount: archived.itemCount },
      { id: "project-checkpoints", byteSize: checkpoints.byteSize, itemCount: checkpoints.itemCount, estimated: true },
      { id: "git-diff-snapshots", byteSize: gitDiffSnapshots.byteSize, itemCount: gitDiffSnapshots.itemCount },
      { id: "temporary-chats", byteSize: temporaryChats.byteSize, itemCount: temporaryChats.itemCount },
    ],
    archives,
    warnings: checkpoints.warnings,
  }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
