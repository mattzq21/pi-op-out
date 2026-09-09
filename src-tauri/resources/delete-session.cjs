const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");

function git(cwd, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], {
      env: { ...process.env, LC_ALL: "C" }, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function readFile(file, optional = false) {
  let metadata;
  try { metadata = await fs.lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
  if (!metadata.isFile()) throw new Error(`Refusing to delete a non-regular file: ${file}`);
  return { file, body: await fs.readFile(file), metadata, deleted: false };
}

async function restoreFile(saved) {
  if (!saved.deleted) return;
  const temporary = `${saved.file}.${randomUUID()}.restore`;
  try {
    await fs.writeFile(temporary, saved.body, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporary, saved.metadata.mode & 0o777);
    await fs.utimes(temporary, saved.metadata.atime, saved.metadata.mtime);
    // Do not overwrite a replacement created by another process during deletion.
    await fs.link(temporary, saved.file);
  } catch (error) {
    throw new Error(`Could not restore ${saved.file}: ${error.message}; recovery copy: ${temporary}`);
  }
  await fs.unlink(temporary);
}

function transaction(refs, restore) {
  return ["start", ...refs.map(({ ref, oid }) => restore ? `create ${ref} ${oid}` : `delete ${ref} ${oid}`), "prepare", "commit", ""].join("\n");
}

async function snapshotRefs(entries, header) {
  const id = header.id.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";
  const prefix = `refs/pi-session-snapshots/chats/${id}/`;
  const legacy = `refs/pi-session-snapshots/${id}`;
  const roots = new Set([header.cwd]);
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot" && typeof entry.data?.repositoryRoot === "string") {
      roots.add(entry.data.repositoryRoot);
    }
  }
  const repositories = new Map();
  for (const cwd of roots) {
    let common;
    try { common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(); }
    catch (error) {
      if (error.message.startsWith("fatal: not a git repository")) continue;
      throw error;
    }
    const key = await fs.realpath(common);
    if (repositories.has(key)) continue;
    const output = await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix, legacy]);
    const refs = output.trim().split("\n").filter(Boolean).map((line) => {
      const [ref, oid] = line.split(" "); return { ref, oid };
    }).filter(({ ref }) => ref.startsWith(prefix) || ref === legacy);
    repositories.set(key, { cwd, refs, deleted: false });
  }
  return [...repositories.values()].filter(({ refs }) => refs.length);
}

async function main() {
  const target = JSON.parse(process.argv[1]);
  const root = await fs.realpath(target.root || path.join(os.homedir(), ".piop", "sessions"));
  const source = await fs.realpath(target.path);
  const relative = path.relative(root, source);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.extname(source) !== ".jsonl") {
    throw new Error("Only Piop sessions can have their supporting data deleted");
  }
  const lock = path.join(root, `.delete-${createHash("sha256").update(source).digest("hex")}.lock`);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Deletion is already in progress for this session"); throw error; }
  let preserveRecovery = false;
  try {
    const [trace, sidecar] = await Promise.all([readFile(source), readFile(source.replace(/\.jsonl$/, ".diffs.json"), true)]);
    const files = sidecar ? [sidecar] : [];
    const entries = trace.body.toString("utf8").split("\n").filter((line) => line.trim()).map(JSON.parse);
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) {
      throw new Error("Invalid session header; nothing was deleted");
    }
    if (target.activeSessionIds.includes(header.id)) throw new Error("Close the session before deleting it");
    const repositories = await snapshotRefs(entries, header);
    const backups = await Promise.allSettled(files.map((saved, index) => fs.writeFile(path.join(lock, `${index}.backup`), saved.body, { flag: "wx", mode: 0o600 })));
    const backupFailure = backups.find((result) => result.status === "rejected");
    if (backupFailure) throw backupFailure.reason;
    await fs.writeFile(path.join(lock, "recovery.json"), JSON.stringify({
      files: files.map((saved, index) => ({ path: saved.file, backup: `${index}.backup`, mode: saved.metadata.mode & 0o777, atime: saved.metadata.atime, mtime: saved.metadata.mtime })),
      repositories: repositories.map(({ cwd, refs }) => ({ cwd, refs })),
    }), { flag: "wx", mode: 0o600 });
    // Keep file bytes and ref OIDs until all deletions have settled, including
    // failures. Promise.all would allow rollback to race an unfinished delete.
    const results = await Promise.allSettled([
      ...files.map(async (saved) => {
        const current = await fs.lstat(saved.file);
        if (current.ino !== saved.metadata.ino || current.dev !== saved.metadata.dev || current.size !== saved.metadata.size || current.mtimeMs !== saved.metadata.mtimeMs || current.ctimeMs !== saved.metadata.ctimeMs) {
          throw new Error(`Session file changed during deletion: ${saved.file}`);
        }
        await fs.unlink(saved.file); saved.deleted = true;
      }),
      ...repositories.map(async (repository) => {
        await git(repository.cwd, ["update-ref", "--stdin"], transaction(repository.refs, false));
        repository.deleted = true;
      }),
    ]);
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
  } finally {
    // Lock cleanup is bookkeeping after commit/rollback, not a failed deletion.
    if (!preserveRecovery) await fs.rm(lock, { recursive: true }).catch((error) => console.error(`Could not remove deletion recovery directory ${lock}: ${error.message}`));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
