const { validSessionHeader } = require("./session-header.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const transactions = require('./session-transactions.cjs');
const deletionTransaction = require('./delete-transaction.cjs');
const ownerLocks = require('./transaction-owner-locks.cjs');
const { lockStorage } = require('./restore-transaction.cjs');
const { withReferencePublicationLock } = require('./storage-lock.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { collectRetention } = require('./deletion-retention.cjs');
const { collectDeferredRetention } = require('./retention-collection.cjs');
const { recordRetention } = require('./retention-candidates.cjs');

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

async function collectDeletionFiles(sources, request, files) {
  for (const source of sources) {
    const trace = await readFile(source);
    files.push(trace);
    const snapshots = await readSnapshotDirectory(source.replace(/\.jsonl$/, ".snapshots"));

    if (snapshots) files.push(snapshots);
    const loopState = await readFile(`${source}.loop-detection.json`, true);

    if (loopState) files.push(loopState);
    const entries = trace.body.toString("utf8").split("\n").filter((line) => line.trim()).map(JSON.parse);
    const header = entries[0];
    validateHeader(header, request);
    trace.sessionId = header.id;
  }
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
  await collectDeletionFiles(sources, request, files);
  const retention = collectRetention(root, sources, files);
  const transaction = deletionTransaction.create(root, files, sources);
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

  if ((target.activeSessionIds ?? []).includes(header.id)) throw new Error("Close the session before deleting it");

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
