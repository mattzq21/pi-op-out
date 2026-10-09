const { acquireReferencePublicationLock } = require('./storage-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validSessionHeader } = require('./session-header.cjs');
const transactions = require('./session-transactions.cjs');
const archiveTransaction = require('./archive-transaction.cjs');
const goalAssets = require('./session-broker/goal-assets.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { lockStorage } = require('./restore-transaction.cjs');

const request = process.argv[1] === '--recover' ? null : JSON.parse(process.argv[1]);

const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

const sessions = fs.realpathSync(path.join(root, 'sessions'));

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function readSession(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
  const header = entries[0];

  if (!validSessionHeader(header)) throw new Error(`Invalid session: ${file}`);

  return { file, entries, header };
}

function backupRecord(record, transaction) {
  fs.copyFileSync(record.file, record.backup, fs.constants.COPYFILE_EXCL);
  transactions.syncTree(record.backup);
  record.backupIdentity = transactions.describe(record.backup);

  if (!transactions.matches(record.file, record.original) || !transactions.sameContents(record.backup, record.original)) throw new Error('The conversation changed while its archive backup was created');
  archiveTransaction.save(transaction);
}

function main() {
  transactions.recover(root);
  recoverStorage(root);

  if (!request) return;

  if (request.transaction) return executeArchive(archiveTransaction.load(root, request.transaction));
  const records = prepareArchive();

  if (request.inspect) {
    process.stdout.write(JSON.stringify([]));

    return;
  }

  const transaction = archiveTransaction.plan(root, records);

  if (request.action === 'plan') {
    process.stdout.write(JSON.stringify({ transaction: transaction.id }));

    return;
  }

  return executeArchive(transaction);
}

function prepareArchive() {
  if (!Array.isArray(request.paths) || !request.paths.length) throw new Error('No conversations selected');

  return [...new Set(request.paths.map(file => fs.realpathSync(file)))].map(file => {
    if (!inside(sessions, file) || !file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) throw new Error('Only active piop sessions can be archived');

    return readSession(file);
  });
}

function executeArchive(transaction) {
  archiveTransaction.prepare(transaction);

  try {
    for (const record of transaction.records) {
      const { entries, header } = readSession(record.file);

      if (header.id !== record.sessionId) throw new Error('Archive conversation identity changed');
      backupRecord(record, transaction);
      header.archiveSessionPath = record.file;
      header.goalAssets = goalAssets.retainHistory(root, entries, header.id, record.destination);
      fs.writeFileSync(record.prepared, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: record.mode });
      transactions.syncTree(record.prepared);
      record.preparedIdentity = transactions.describe(record.prepared);
      archiveTransaction.save(transaction);
    }

    archiveTransaction.begin(transaction);

    for (const record of transaction.records) archiveTransaction.publishRecord(transaction, record);
    archiveTransaction.commit(transaction);
  } catch (error) {
    if (transaction.state === 'committed') throw error;

    if (transaction.state === 'preparing') archiveTransaction.recover(root);
    else archiveTransaction.rollback(transaction);
    throw error;
  }

  archiveTransaction.finish(transaction);
}

try {
  if (lockStorage(root)) {
    const release = acquireReferencePublicationLock(root);

    try { main(); } finally { release(); }
  }
}
catch (error) { console.error(error.message); process.exitCode = 1; }
