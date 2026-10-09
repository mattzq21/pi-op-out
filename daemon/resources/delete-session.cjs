const { Type } = require("typebox");
const { Check } = require("typebox/value");
const { unavailableCheckpoint, promptCheckpoint, snapshotCheckpoint, validSessionHeader } = require("./checkpoint-schemas.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const transactions = require('./session-transactions.cjs');
const deletionTransaction = require('./delete-transaction.cjs');
const diffStore = require('./session-broker/git-diff-store.cjs');
const ownerLocks = require('./transaction-owner-locks.cjs');
const { lockStorage } = require('./restore-transaction.cjs');
const { withReferencePublicationLock } = require('./storage-lock.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { collectRetention } = require('./deletion-retention.cjs');
const { collectDeferredRetention } = require('./retention-collection.cjs');
const { recordRetention } = require('./retention-candidates.cjs');

async function git(cwd, args, input = "") {
  try { return transactions.git(cwd, args, input); }
  catch (error) { throw new Error(String(error.stderr ?? '').trim() || error.message); }
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

async function collectDeletionFiles(sources, request, files) {
  const repositoriesByPath = new Map();

    for (const source of sources) {
      const trace = await readFile(source);
      files.push(trace);
      const snapshots = await readSnapshotDirectory(source.replace(/\.jsonl$/, ".snapshots"));

      if (snapshots) files.push(snapshots);
      const entries = trace.body.toString("utf8").split("\n").filter((line) => line.trim()).map(JSON.parse);
      const header = entries[0];
      validateHeader(header, request);
      trace.sessionId = header.id;
      verifyCompletedTransfers(source);

      mergeRepositories(repositoriesByPath, await snapshotRefs(entries, header));
    }

    return [...repositoriesByPath.values()];

}

function verifyCompletedTransfers(source) {
  const file = source.replace(/\.jsonl$/, '.diffs.json');

  const state = ownerLocks.withFile(file + '.lock', () => diffStore.readStore(file, false));

  if (Object.values(state.transfers).some(transfer => transfer.committed !== true)) throw new Error('Unfinished project diff transfers still own their log and staged contents; recover them before deleting this conversation');

}

function deletionStorageRoot(target) {
  return fs.realpath(target.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", target.area === "archived" ? "archived" : "sessions"));
}

async function main(root, request) {
  const targets = request.targets || [request];
  transactions.recover(root);
  recoverStorage(root);
  const sources = await Promise.all(targets.map(sessionSource));

  if (!sources.length || new Set(sources).size !== sources.length) throw new Error("Invalid conversation deletion targets");
  const files = [];
  const repositories = await collectDeletionFiles(sources, request, files);
  const retention = collectRetention(root, sources, files);
  const transaction = deletionTransaction.create(root, files, repositories, sources);
  recordRetention(root, transaction.id, retention.deferred);

  try {
    deletionTransaction.stage(transaction);
    deletionTransaction.commit(transaction);
  } catch (error) {
    if (deletionTransaction.committed(transaction)) throw new Error(`${error.message}\nDeletion commit evidence was retained at ${transaction.garbagePath}; recovery will finish it.`);

    try { deletionTransaction.rollback(transaction); }
    catch (failure) { throw new Error(`${error.message}\nDeletion recovery is pending: ${failure.message}\nRecovery data: ${transaction.container}`); }

    throw new Error(`${error.message}\nDeletion was rolled back.`);
  }

  try { deletionTransaction.finish(transaction); collectDeferredRetention(root); }
  catch (error) { console.error(`Deletion committed; cleanup will retry. Recovery data: ${transaction.garbagePath}: ${error.message}`); }
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

function validateHeader(header, target) {
  if (!validSessionHeader(header)) {
    throw new Error("Invalid session header; nothing was deleted");
  }

  if (target.activeSessionIds.includes(header.id)) throw new Error("Close the session before deleting it");

}

async function start() {
  const request = JSON.parse(process.argv[1]);

  if (request.blank) return deleteBlank(request.blank);

  if (request.retentionOnly === true) {
    const root = await fs.realpath(request.root);

    if (!lockStorage(root, true)) return;

    return withReferencePublicationLock(root, () => {
      transactions.recover(root);
      recoverStorage(root);
      collectDeferredRetention(root);
    }, true);
  }

  const targets = request.targets || [request];

  if (!targets.length) throw new Error("Invalid conversation deletion targets");
  const roots = await Promise.all(targets.map(async target => path.dirname(await deletionStorageRoot(target))));

  if (new Set(roots).size !== 1) throw new Error("Conversation deletion targets must share storage");

  if (!lockStorage(roots[0])) return;

  return withReferencePublicationLock(roots[0], () => main(roots[0], request));
}

async function deleteBlank(target) {
  const blank = require('./blank-session-target.cjs');
  const candidate = blank.prepare(target);

  if (!candidate || !lockStorage(candidate.root, true)) return;

  return withReferencePublicationLock(candidate.root, () => ownerLocks.withOwnersAsync(candidate.root, [candidate.id], async () => {
    const current = blank.prepare(target);

    if (!current || current.id !== candidate.id || current.target.path !== candidate.target.path) return;
    await main(current.root, { targets: [current.target], activeSessionIds: [] });
  }), true);
}

start().catch((error) => { console.error(error.message); process.exitCode = 1; });
