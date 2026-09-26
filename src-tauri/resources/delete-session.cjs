const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");

function git(cwd, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], {
      env: { ...process.env, LC_ALL: "C" }, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin.on("error", () => { });
    child.stdin.end(input);
  });
}

async function readFile(file, optional = false) {
  let metadata;
  try { metadata = await fs.lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
  if (!metadata.isFile()) throw new Error(`Refusing to delete a non-regular file: ${file}`);
  return { file, body: await fs.readFile(file), metadata, stagedPath: "", staged: false };
}

async function restoreFile(saved) {
  if (!saved.staged) return;
  try {
    await fs.link(saved.stagedPath, saved.file);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Refusing to overwrite a replacement created during deletion: ${saved.file}`);
    throw new Error(`Could not restore ${saved.file}: ${error.message}`);
  }
  try {
    await fs.unlink(saved.stagedPath);
    saved.staged = false;
  } catch (error) {
    throw new Error(`Restored ${saved.file}, but could not remove its staged recovery file ${saved.stagedPath}: ${error.message}`);
  }
}

async function stageFile(saved) {
  const current = await fs.lstat(saved.file);
  if (current.ino !== saved.metadata.ino || current.dev !== saved.metadata.dev || current.size !== saved.metadata.size || current.mtimeMs !== saved.metadata.mtimeMs || current.ctimeMs !== saved.metadata.ctimeMs) {
    throw new Error(`Session file changed during deletion: ${saved.file}`);
  }
  await fs.rename(saved.file, saved.stagedPath);
  saved.staged = true;
  const staged = await fs.lstat(saved.stagedPath);
  if (staged.ino !== saved.metadata.ino || staged.dev !== saved.metadata.dev || staged.size !== saved.metadata.size || staged.mtimeMs !== saved.metadata.mtimeMs) {
    throw new Error(`Session file changed while it was staged for deletion: ${saved.file}`);
  }
}

function transaction(refs, restore) {
  return ["start", ...refs.map(({ ref, oid }) => restore ? `create ${ref} ${oid}` : `delete ${ref} ${oid}`), "prepare", "commit", ""].join("\n");
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
    if (!repositories.has(key)) repositories.set(key, { cwd: key, displayPath: cwd, required: false, commits: new Set(), expectedRefs: new Map(), refs: [], deleted: false });
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

async function main() {
  const target = JSON.parse(process.argv[1]);
  const source = await sessionSource(target);
  const lock = await acquireDeletionLock(source);
  let preserveRecovery = false;
  let lockRemoved = false;
  try {
    const [trace, sidecar, loopCheckpoint] = await Promise.all([readFile(source), readFile(source.replace(/\.jsonl$/, ".diffs.json"), true), readFile(`${source}.loop-detection.json`, true)]);
    const files = [trace, sidecar, loopCheckpoint].filter(Boolean);
    const entries = trace.body.toString("utf8").split("\n").filter((line) => line.trim()).map(JSON.parse);
    const header = entries[0];
    validateHeader(header, target);
    const repositories = await snapshotRefs(entries, header);
    files.forEach((saved, index) => { saved.stagedPath = path.join(lock, `${index}.staged`); });
    await fs.writeFile(path.join(lock, "recovery.json"), JSON.stringify({
      files: files.map((saved) => ({ path: saved.file, staged: path.basename(saved.stagedPath), mode: saved.metadata.mode & 0o777, atime: saved.metadata.atime, mtime: saved.metadata.mtime })),
      repositories: repositories.map(({ cwd, refs }) => ({ cwd, refs })),
    }), { flag: "wx", mode: 0o600 });
    const staged = await Promise.allSettled(files.map(stageFile));
    const stageFailures = staged.filter((result) => result.status === "rejected");
    if (stageFailures.length) {
      const rollback = await Promise.allSettled(files.map(restoreFile));
      const recoveryErrors = rollback.filter((result) => result.status === "rejected");
      preserveRecovery = recoveryErrors.length > 0;
      throw new Error([
        `Could not stage session files for deletion: ${stageFailures.map((result) => result.reason.message).join("; ")}`,
        recoveryErrors.length ? `Rollback failed: ${recoveryErrors.map((result) => result.reason.message).join("; ")}. Recovery files retained in ${lock}` : "Deletion was rolled back.",
      ].join("\n"));
    }
    const results = await Promise.allSettled(repositories.map(async (repository) => {
      await git(repository.cwd, ["update-ref", "--stdin"], transaction(repository.refs, false));
      repository.deleted = true;
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      const rollback = await Promise.allSettled([
        ...files.map(restoreFile),
        ...repositories.filter((repository) => repository.deleted).map((repository) => git(repository.cwd, ["update-ref", "--stdin"], transaction(repository.refs, true))),
      ]);
      const recoveryErrors = rollback.filter((result) => result.status === "rejected");
      preserveRecovery = recoveryErrors.length > 0;
      throw new Error([
        `Deletion failed: ${failures.map((result) => result.reason.message).join("; ")}`,
        recoveryErrors.length ? `Rollback failed: ${recoveryErrors.map((result) => result.reason.message).join("; ")}. Recovery files retained in ${lock}` : "Deletion was rolled back.",
      ].join("\n"));
    }
    try { await fs.rm(lock, { recursive: true }); lockRemoved = true; }
    catch (error) {
      preserveRecovery = true;
      throw new Error(`Conversation refs were removed, but staged files could not be erased: ${error.message}. Recovery files retained in ${lock}`);
    }
  } finally {
    if (!preserveRecovery && !lockRemoved) await fs.rm(lock, { recursive: true }).catch((error) => console.error(`Could not remove deletion recovery directory ${lock}: ${error.message}`));
  }
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
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Invalid prompt checkpoint repository');
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
    const [ref, oid] = line.split(" "); return { ref, oid };
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
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) {
    throw new Error("Invalid session header; nothing was deleted");
  }
  if (target.activeSessionIds.includes(header.id)) throw new Error("Close the session before deleting it");

}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
