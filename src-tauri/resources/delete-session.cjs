const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { unavailableCheckpoint, promptCheckpoint, snapshotCheckpoint, validSessionHeader } = require("./checkpoint-schemas.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { recover, createJournal, removeCheckpointRefs, cleanupCommitted, sync, syncTree } = require("./delete-recovery.cjs");
const { runWithStorageLock } = require("./storage-lock.cjs");
const { recoverStorage } = require("./storage-recovery.cjs");

function git(cwd, args, input = "") {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", input, timeout: 120000,
      maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe", 3, 4],
    });
  } catch (error) { throw new Error(error.stderr?.toString().trim() || error.message); }
}

async function readFile(file, optional = false) {
  let metadata;

  try { metadata = await fs.lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }

  if (!metadata.isFile()) throw new Error(`Refusing to delete a non-regular file: ${file}`);

  return { file, body: await fs.readFile(file), metadata, stagedPath: "", staged: false };
}

async function readSnapshotDirectory(file) {
  let metadata;

  try { metadata = await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }

  if (!metadata.isDirectory()) throw new Error(`Invalid snapshot directory: ${file}`);

  return { file, metadata, directory: true, stagedPath: "", staged: false };
}

async function stageFile(saved) {
  const current = await fs.lstat(saved.file);

  if (current.ino !== saved.metadata.ino || current.dev !== saved.metadata.dev || current.size !== saved.metadata.size || current.mtimeMs !== saved.metadata.mtimeMs || current.ctimeMs !== saved.metadata.ctimeMs) {
    throw new Error(`Session file changed during deletion: ${saved.file}`);
  }

  syncTree(saved.file);
  await fs.rename(saved.file, saved.stagedPath);
  saved.staged = true;
  sync(path.dirname(saved.stagedPath));
  sync(path.dirname(saved.file));
  const staged = await fs.lstat(saved.stagedPath);

  if (staged.ino !== saved.metadata.ino || staged.dev !== saved.metadata.dev || staged.size !== saved.metadata.size || staged.mtimeMs !== saved.metadata.mtimeMs) {
    throw new Error(`Session file changed while it was staged for deletion: ${saved.file}`);
  }
}

function checkpointRepository(roots, cwd) {
  if (!roots.has(cwd)) roots.set(cwd, { required: false, commits: new Set(), expectedRefs: new Map() });

  return roots.get(cwd);
}

async function snapshotRefs(entries, header) {
  const id = header.id.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";
  const prefix = `refs/pi-session-snapshots/chats/${id}/`;
  const legacy = `refs/pi-session-snapshots/${id}`;
  const roots = new Map();
  checkpointRepository(roots, header.cwd);

  for (const entry of entries) {
    collectSnapshot(entry, roots, prefix, legacy);
    collectPromptCheckpoint(entry, roots, header, prefix);
  }

  const repositories = new Map();

  for (const [cwd, checkpoint] of roots) {
    if (!await checkpointDirectory(cwd, checkpoint)) continue;
    const common = await checkpointCommonDir(cwd, checkpoint);

    if (common === undefined) continue;
    const key = await fs.realpath(common);

    if (!repositories.has(key)) repositories.set(key, { cwd: key, displayPath: cwd, required: false, commits: new Set(), expectedRefs: new Map(), refs: [] });
    const repository = repositories.get(key);
    repository.required ||= checkpoint.required;
    checkpoint.commits.forEach((commit) => repository.commits.add(commit));
    checkpoint.expectedRefs.forEach((commit, ref) => repository.expectedRefs.set(ref, commit));
  }

  for (const repository of repositories.values()) {
    await verifyRepositoryRefs(repository, prefix, legacy);
  }

  return [...repositories.values()].filter(({ refs }) => refs.length);
}

function mergeRepositories(repositoriesByPath, repositories) {
  for (const repository of repositories) {
        const existing = repositoriesByPath.get(repository.cwd);

        if (existing) {
          for (const ref of repository.refs) {
            const duplicate = existing.refs.find(candidate => candidate.ref === ref.ref);

            if (duplicate && duplicate.oid !== ref.oid) throw new Error("Checkpoint refs changed during deletion");

            if (!duplicate) existing.refs.push(ref);
          }
        } else repositoriesByPath.set(repository.cwd, repository);
  }
}

async function collectDeletionFiles(targets, sources, request, files) {
  const repositoriesByPath = new Map();
    const selected = new Set(sources);

    for (const [index, source] of sources.entries()) {
      const target = targets[index];
      const [trace, sidecar, loopCheckpoint] = await Promise.all([readFile(source), readFile(source.replace(/\.jsonl$/, ".diffs.json"), true), readFile(`${source}.loop-detection.json`, true)]);
      files.push(...[trace, sidecar, loopCheckpoint].filter(Boolean));
      const snapshots = await readSnapshotDirectory(source.replace(/\.jsonl$/, ".snapshots"));

      if (snapshots) files.push(snapshots);
      const entries = trace.body.toString("utf8").split("\n").filter((line) => line.trim()).map(JSON.parse);
      const header = entries[0];
      validateHeader(header, request);
      trace.sessionId = header.id;
      await appendConversationNote(files, header, target);
      await appendQueuedInput(files, header, target);
      const directory = await archivedDirectory(source, header, target, selected);

      if (directory && !files.some(saved => saved.file === directory.file)) files.push(directory);

      mergeRepositories(repositoriesByPath, await snapshotRefs(entries, header));
    }

    return [...repositoriesByPath.values()];

}

function deletionError(error, recoveryErrors, lock) {
  return new Error([
      `Deletion failed: ${error.message}`,
      recoveryErrors.length ? `Rollback failed: ${recoveryErrors.map(result => result.reason.message).join("; ")}. Recovery files retained in ${lock}` : "Deletion was rolled back.",
    ].join("\n"));
}

function deletionStorageRoot(target) {
  return fs.realpath(target.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", target.area === "archived" ? "archived" : "sessions"));
}

async function stageDeletion(files, repositories) {
    const staged = await Promise.allSettled(files.map(stageFile));
    const stageFailures = staged.filter((result) => result.status === "rejected");

    if (stageFailures.length) throw new Error(`Could not stage session files for deletion: ${stageFailures.map((result) => result.reason.message).join("; ")}`);

    for (const repository of repositories) removeCheckpointRefs(repository);

}

async function main(root) {
  const request = JSON.parse(process.argv[1]);
  const targets = request.targets || [request];
  recoverStorage(root);
  const sources = await Promise.all(targets.map(sessionSource));

  if (!sources.length || new Set(sources).size !== sources.length) throw new Error("Invalid conversation deletion targets");
  const source = sources[0];
  const lock = await acquireDeletionLock(source);
  const childLocks = [];
  let committed = false;
  const files = [];

  try {
    for (const child of sources.slice(1)) childLocks.push(await acquireDeletionLock(child));
    const repositories = await collectDeletionFiles(targets, sources, request, files);
    const sessionIds = files.flatMap(saved => saved.sessionId ? [saved.sessionId] : []);
    const journal = createJournal(root, lock, childLocks, files, repositories, sessionIds);
    await stageDeletion(files, journal.repositories);
    await fs.rename(lock, journal.garbagePath);
    committed = true;
    sync(path.dirname(journal.garbagePath));
    sync(path.dirname(lock));
  } catch (error) {
    if (committed) console.error(`Deletion committed; recovery cleanup is pending: ${error.message}`);
    else {
      const recoveryErrors = [];

      try { recover(root); } catch (reason) { recoveryErrors.push({ reason }); }

      throw deletionError(error, recoveryErrors, lock);
    }
  }

  try { cleanupCommitted(root); }
  catch (error) { console.error(`Deletion committed; recovery cleanup is pending: ${error.message}`); }
}

async function appendConversationNote(files, header, target) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.id)) return undefined;
  const storage = target.root ? path.dirname(await fs.realpath(target.root)) : path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");

  const note = await readFile(path.join(storage, "notes", "chats", `${header.id.toLowerCase()}.md`), true);

  if (note && !files.some(saved => saved.file === note.file)) files.push(note);
}

async function appendQueuedInput(files, header, target) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.id)) return;
  const storage = path.dirname(await deletionStorageRoot(target));
  const directory = path.join(storage, "queued-input");
  let metadata;

  try { metadata = await fs.lstat(directory); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }

  if (!metadata.isDirectory()) throw new Error("Invalid queued input directory");
  const name = `${header.id.toLowerCase()}.json`;
  const temporary = new RegExp(`^\\.${name.replaceAll(".", "\\.")}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`, "i");

  for (const entry of await fs.readdir(directory)) {
    if (entry !== name && !temporary.test(entry)) continue;
    const queued = await readFile(path.join(directory, entry), true);

    if (queued && !files.some(saved => saved.file === queued.file)) files.push(queued);
  }
}

async function archivedDirectoryMetadata(directory) {
  const metadata = await fs.lstat(directory);

  if (!metadata.isDirectory()) throw new Error("Archived working directory is not a directory");

  return { file: directory, metadata, directory: true, stagedPath: "", staged: false };
}

async function referencesDirectory(file, storedPath) {
  const first = (await fs.readFile(file, "utf8")).split("\n").find((line) => line.trim());
  const header = JSON.parse(first);

  return header.worktreeRestore?.kind === "directory" && header.worktreeRestore.storedPath === storedPath;
}

async function directoryReferenced(location, storedPath, selected) {
  let entries;

  try { entries = await fs.readdir(location, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }

  for (const entry of entries) {
    const file = path.join(location, entry.name);

    if (entry.isDirectory() && await directoryReferenced(file, storedPath, selected)) return true;

    if (!entry.isFile() || !file.endsWith(".jsonl") || selected.has(file)) continue;

    if (await referencesDirectory(file, storedPath)) return true;
  }

  return false;
}

async function archivedDirectory(source, header, target, selected = new Set([source])) {
  const saved = header.worktreeRestore;

  if (saved?.kind !== "directory") return undefined;
  const area = await deletionStorageRoot(target);
  const storage = path.dirname(area);
  let directory;

  try { directory = await fs.realpath(saved.storedPath); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }

  const root = await fs.realpath(path.join(storage, "archived-tmp"));

  if (path.dirname(directory) !== root) throw new Error("Invalid archived working directory");

  const locations = new Set([area, path.join(storage, "sessions"), path.join(storage, "archived")]);

  for (const location of locations) {
    if (await directoryReferenced(location, saved.storedPath, selected)) return undefined;
  }

  return archivedDirectoryMetadata(directory);
}

function collectSnapshot(entry, roots, prefix, legacy) {
  if (entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot" && snapshotCheckpoint(entry.data)) {
    if (entry.data.ref.startsWith(prefix) || entry.data.ref === legacy) {
      const repository = checkpointRepository(roots, entry.data.repositoryRoot);
      repository.required = true;
      repository.commits.add(entry.data.commit);
      repository.expectedRefs.set(entry.data.ref, entry.data.commit);
    }
  }
  else if (entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot" && !unavailableCheckpoint(entry.data)) {
    throw new Error("Cannot safely delete a conversation with invalid project snapshot metadata. The conversation was not deleted.");
  }

}

function promptRepository(entry, header) { return entry.data.repositoryRoot ?? header.checkpointRepositoryRoot ?? header.cwd; }

function collectPromptCheckpoint(entry, roots, header, prefix) {
  if (entry.type === "custom" && entry.customType === "pi-project-prompt-checkpoint" && promptCheckpoint(entry.data)) {
    const cwd = promptRepository(entry, header);

    if (!Check(Type.String(), cwd) || !path.isAbsolute(cwd)) throw new Error('Invalid prompt checkpoint repository');
    const repository = checkpointRepository(roots, cwd);
    repository.required = true;
    repository.commits.add(entry.data.commit);
    repository.expectedRefs.set(`${prefix}prompts/${entry.data.key}`, entry.data.commit);
  }
  else if (entry.type === "custom" && entry.customType === "pi-project-prompt-checkpoint" && !unavailableCheckpoint(entry.data)) {
    throw new Error("Cannot safely delete a conversation with invalid prompt checkpoint metadata. The conversation was not deleted.");
  }

}

async function checkpointDirectory(cwd, checkpoint) {
  try {
    if (!(await fs.stat(cwd)).isDirectory()) {
      if (checkpoint.required) throw new Error(`Checkpoint repository is no longer a directory: ${cwd}`);

      return false;
    }
  } catch (error) {
    if (error.code === "ENOENT" && !checkpoint.required) return false;

    if (error.code === "ENOENT") throw new Error(`Cannot verify checkpoint cleanup because the repository no longer exists: ${cwd}. The conversation was not deleted.`);
    throw error;
  }

  return true;
}

async function checkpointCommonDir(cwd, checkpoint) {
  let common;

  try { common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(); }
  catch (error) {
    if (error.message.startsWith("fatal: not a git repository") && !checkpoint.required) return undefined;

    if (error.message.startsWith("fatal: not a git repository")) throw new Error(`Cannot verify checkpoint cleanup because the repository is unavailable: ${cwd}. The conversation was not deleted.`);
    throw error;
  }

  return common;
}

async function verifyRepositoryRefs(repository, prefix, legacy) {
  const output = await git(repository.cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix, legacy]);

  const refs = output.trim().split("\n").filter(Boolean).map((line) => {
    const [ref, oid] = line.split(" ");

    return { ref, oid };
  }).filter(({ ref }) => ref.startsWith(prefix) || ref === legacy);

  repository.refs = refs;

  if (!refs.length && repository.required) throw new Error(`Cannot verify checkpoint repository identity at ${repository.displayPath}: the conversation's refs are missing. The conversation was not deleted.`);

  if (!refs.length) return;
  const actual = new Map(refs.map(({ ref, oid }) => [ref, oid]));

  for (const [ref, commit] of repository.expectedRefs) {
    if (actual.has(ref) && actual.get(ref) !== commit) throw new Error(`Cannot verify checkpoint repository identity at ${repository.displayPath}: ${ref} no longer points to its recorded commit. The conversation was not deleted.`);
  }

  const matched = refs.some(({ ref, oid }) => repository.expectedRefs.get(ref) === oid || repository.commits.has(oid));

  if (!matched) throw new Error(`Cannot verify checkpoint repository identity at ${repository.displayPath}: no conversation ref matches the recorded checkpoint commits. The conversation was not deleted.`);

}

async function sessionSource(target) {
  const area = target.area === "archived" ? "archived" : "sessions";
  const root = await fs.realpath(target.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", area));
  const source = await fs.realpath(target.path);
  const relative = path.relative(root, source);

  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.extname(source) !== ".jsonl") {
    throw new Error("Only Piop sessions can have their supporting data deleted");
  }

  return source;
}

async function acquireDeletionLock(source) {
  const lock = path.join(path.dirname(source), `.delete-${createHash("sha256").update(source).digest("hex")}.lock`);

  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Deletion is already in progress for this session"); throw error; }

  return lock;
}

function validateHeader(header, target) {
  if (!validSessionHeader(header)) {
    throw new Error("Invalid session header; nothing was deleted");
  }

  if (target.activeSessionIds.includes(header.id)) throw new Error("Close the session before deleting it");

}

async function start() {
  const request = JSON.parse(process.argv[1]);
  const targets = request.targets || [request];

  if (!targets.length) throw new Error("Invalid conversation deletion targets");
  const roots = await Promise.all(targets.map(async target => path.dirname(await deletionStorageRoot(target))));

  if (new Set(roots).size !== 1) throw new Error("Conversation deletion targets must share storage");
  await runWithStorageLock(roots[0], () => main(roots[0]));
}

start().catch((error) => { console.error(error.message); process.exitCode = 1; });
