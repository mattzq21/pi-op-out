const { Type } = require("typebox");

const { Check } = require("typebox/value");

const { unavailableCheckpoint, promptCheckpoint, snapshotCheckpoint, validSessionHeader } = require("./checkpoint-schemas.cjs");

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

  const result = { checkpointRepositories: [...checkpointRepositories.values()], cwd: validSessionHeader(header) ? header.cwd : undefined };

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

  const archive = {
      ...archiveLocation(header, file),
      name: explicitName || firstPrompt || "Untitled conversation",
      modifiedAt: Math.floor(metadata.mtimeMs / 1000),
      byteSize: metadata.size + diffBytes,
      deletable,
      ...await archivedWorktree(header),
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

async function archivedWorktree(header) {
  if (!validSessionHeader(header)) return {};
  const current = await currentWorktree(header.cwd);

  if (current === undefined) return restorableWorktree(header.worktreeRestore);

  return current ? { worktreePath: current } : { restorable: true };

}

async function restorableWorktree(saved) {
    if (saved?.kind === 'directory' && path.isAbsolute(saved.path ?? '') && path.isAbsolute(saved.storedPath ?? '')) {
      try {
        try { await fs.lstat(saved.path); return {}; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const stored = await fs.realpath(saved.storedPath);
        const root = await fs.realpath(path.join(piopRoot, 'archived-tmp'));
        if (path.dirname(stored) !== root || !(await fs.lstat(stored)).isDirectory()) return {};
        return { restorable: true };
      } catch (error) { return { restoreError: `Archived directory unavailable: ${error.message}` }; }
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

      if (error.message.startsWith("fatal: not a git repository")) return { unavailable: true, error: `Checkpoint repository is no longer a Git repository: ${cwd}` };

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


function checkpointWarnings(repository) {
  return repository.unavailable ? [] : [repository.error];
}

async function checkpointStorage(repositoryRoots, measuredDirectories) {

  const repositories = new Set();
  let byteSize = 0;
  let itemCount = 0;
  const warnings = [];

  for (const cwd of repositoryRoots) {
    try {
      const repository = await checkpointRepository(cwd);

      if (repository.error) { warnings.push(...checkpointWarnings(repository)); continue; }

      const common = repository.common;

      if (repositories.has(common)) continue;
      repositories.add(common);
      const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)"])).trim().split("\n").filter(Boolean);
      const snapshots = refs.filter((ref) => ref === "refs/pi-session-snapshots" || ref.startsWith("refs/pi-session-snapshots/"));

      if (!snapshots.length) continue;
      itemCount += snapshots.length;
      if (measuredDirectories.has(common)) continue;
      const snapshotRefs = new Set(snapshots);
      const ordinary = refs.filter((ref) => !snapshotRefs.has(ref)).map((ref) => `^${ref}`);

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

  return { byteSize, itemCount, warnings, directories: [...repositories] };
}

async function diskStorage(worktreeRoots) {
  const sizes = new Map();
  const seen = new Set();
  const directories = new Set();
  const worktrees = new Set();
  const snapshotCounts = new Map();
  let archivedDirectories = 0;
  const warnings = [];
  const root = await fs.realpath(piopRoot).catch(() => piopRoot);
  const categories = { sessions: "active-conversations", archived: "archived-conversations", "git-snapshots": "git-diff-snapshots", tmp: "temporary-chats", worktrees: "worktrees", "archived-tmp": "archived-worktrees" };
  async function visit(target, category) {
    try {
      const metadata = await fs.lstat(target);
      if (metadata.isDirectory() && target.endsWith('.snapshots')) {
        if (category === 'active-conversations') category = 'git-diff-snapshots';
        else if (category === 'archived-conversations') category = 'archived-git-diff-snapshots';
      }
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      const bytes = typeof metadata.blocks === "number" ? metadata.blocks * 512 : metadata.size;
      sizes.set(category, (sizes.get(category) || 0) + bytes);
      if (!metadata.isDirectory()) return;
      directories.add(target);
      const entries = await fs.readdir(target, { withFileTypes: true });
      if (['git-diff-snapshots', 'archived-git-diff-snapshots'].includes(category) && path.dirname(target).endsWith('.snapshots') && entries.some((entry) => entry.name === 'snapshot.json')) snapshotCounts.set(category, (snapshotCounts.get(category) || 0) + 1);
      if (target === path.join(root, 'archived-tmp')) archivedDirectories = entries.filter((entry) => entry.isDirectory()).length;
      const managed = path.relative(path.join(root, "worktrees"), target).split(path.sep);
      if (category === "worktrees" && managed.length === 2 && !managed.includes("..") && entries.some((entry) => entry.name === ".git")) worktrees.add(target);
      for (const entry of entries) {
        await visit(path.join(target, entry.name), target === root ? (Object.hasOwn(categories, entry.name) ? categories[entry.name] : "other-storage") : category);
      }
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(`${target}: ${error.message}`);
    }
  }
  await visit(root, "other-storage");
  for (const worktree of new Set([...worktrees, ...worktreeRoots])) {
    const canonical = await fs.realpath(worktree).catch(() => worktree);
    await visit(canonical, "worktrees");
    if (directories.has(canonical)) worktrees.add(canonical);
    try {
      const own = await fs.realpath((await git(canonical, ["rev-parse", "--absolute-git-dir"])).trim());
      await visit(own, "worktrees");
    } catch (error) { warnings.push(`${worktree}: ${error.message}`); }
  }
  return { sizes, directories, worktrees, archivedDirectories, snapshotCounts, warnings };

}

async function main() {
  const activeRoot = sessionRoots[0];
  const archiveRoot = sessionRoots[1];

  const [active, archived, gitDiffSnapshots, temporaryChats] = await Promise.all([
    scanDirectory(activeRoot, (entry) => entry.isFile() && entry.name.endsWith(".jsonl"), (entry) => entry.name.endsWith(".jsonl") || entry.name.endsWith(".diffs.json")),
    scanDirectory(archiveRoot, (entry) => entry.isFile() && entry.name.endsWith(".jsonl"), (entry) => entry.name.endsWith(".jsonl") || entry.name.endsWith(".diffs.json")),
    scanDirectory(path.join(piopRoot, "git-snapshots"), (entry, topLevel) => topLevel && entry.isDirectory() && entry.name.startsWith("pi-desktop-diff-"), () => false, false),
    scanDirectory(path.join(piopRoot, "tmp"), (entry, topLevel) => topLevel && entry.isDirectory(), () => false, false),
  ]);

  const checkpointRoots = new Set();
  const worktreeRoots = new Set();
  const archives = [];

  const sessionFiles = [
    ...active.files.filter((file) => file.endsWith(".jsonl")).map((file) => ({ file, archived: false })),
    ...archived.files.filter((file) => file.endsWith(".jsonl")).map((file) => ({ file, archived: true })),
  ];

  for (const candidate of sessionFiles) {
    try {
      const details = await inspectSession(candidate.file, candidate.archived);
      details.checkpointRepositories.forEach((repository) => checkpointRoots.add(repository.root));

      if (details.cwd) {
        const worktree = await currentWorktree(details.cwd);
        if (worktree) worktreeRoots.add(worktree);
      }

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

  const disk = await diskStorage(worktreeRoots);
  const checkpoints = await checkpointStorage(checkpointRoots, disk.directories);
  const directoryCandidates = {
    'active-conversations': [activeRoot],
    'archived-conversations': [archiveRoot],
    'project-checkpoints': checkpoints.directories,
    'git-diff-snapshots': [path.join(piopRoot, 'git-snapshots'), ...active.files.filter((file) => file.endsWith('.jsonl')).map((file) => file.replace(/\.jsonl$/, '.snapshots'))],
    'archived-git-diff-snapshots': archived.files.filter((file) => file.endsWith('.jsonl')).map((file) => file.replace(/\.jsonl$/, '.snapshots')),
    'temporary-chats': [path.join(piopRoot, 'tmp')],
    'worktrees': [path.join(piopRoot, 'worktrees'), ...[...worktreeRoots].filter((directory) => !directory.startsWith(path.join(piopRoot, 'worktrees') + path.sep))],
    'archived-worktrees': [path.join(piopRoot, 'archived-tmp')],
    'other-storage': [piopRoot],
  };
  const categoryDirectories = Object.fromEntries(await Promise.all(Object.entries(directoryCandidates).map(async ([id, candidates]) => {
    const directories = await Promise.all([...new Set(candidates)].map(async (directory) => {
      try { return (await fs.stat(directory)).isDirectory() ? directory : null; }
      catch { return null; }
    }));
    return [id, directories.filter(Boolean)];
  })));

  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);
  process.stdout.write(JSON.stringify({
    categories: [
      { id: "active-conversations", byteSize: disk.sizes.get("active-conversations") || 0, itemCount: active.itemCount },
      { id: "archived-conversations", byteSize: disk.sizes.get("archived-conversations") || 0, itemCount: archived.itemCount },
      { id: "project-checkpoints", byteSize: checkpoints.byteSize, itemCount: checkpoints.itemCount, estimated: true },
      { id: "git-diff-snapshots", byteSize: disk.sizes.get("git-diff-snapshots") || 0, itemCount: gitDiffSnapshots.itemCount + (disk.snapshotCounts.get("git-diff-snapshots") || 0) },
      { id: "archived-git-diff-snapshots", byteSize: disk.sizes.get("archived-git-diff-snapshots") || 0, itemCount: disk.snapshotCounts.get("archived-git-diff-snapshots") || 0 },
      { id: "temporary-chats", byteSize: disk.sizes.get("temporary-chats") || 0, itemCount: temporaryChats.itemCount },
      { id: "worktrees", byteSize: disk.sizes.get("worktrees") || 0, itemCount: disk.worktrees.size },
      { id: "archived-worktrees", byteSize: disk.sizes.get("archived-worktrees") || 0, itemCount: disk.archivedDirectories },
      { id: "other-storage", byteSize: disk.sizes.get("other-storage") || 0, itemCount: 1 },
    ].map((category) => ({ ...category, directories: categoryDirectories[category.id] })),
    archives,
    warnings: [...disk.warnings, ...checkpoints.warnings],
  }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
