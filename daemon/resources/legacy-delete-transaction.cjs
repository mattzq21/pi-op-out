const conversationStorage = require('./conversation-storage.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const io = require('./session-transactions.cjs');
const goalAssets = require('./goal-asset-cleanup.cjs');

const records = require('./deletion-records.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function location(transaction) {
  return io.exists(transaction.container) ? transaction.container : transaction.garbagePath;
}

function save(transaction) {
  records.save(transaction);
}

function validSource(root, source) {
  return ['sessions', 'archived', path.join('notes', 'chats'), 'queued-input'].some(name => io.inside(path.join(root, name), source) && source !== path.join(root, name));
}

function validateIdentity(transaction, root, directory) {
  if (transaction.version !== 3 || transaction.kind !== 'delete' || !uuid.test(transaction.id ?? '') || transaction.root !== root) throw new Error('Unsupported deletion recovery journal');
  validateLocation(transaction, root, directory);
}

function validateLocation(transaction, root, directory) {
  if (transaction.container !== path.join(root, 'delete-transactions', transaction.id) || transaction.garbagePath !== path.join(root, 'deleted-sessions', transaction.id)) throw new Error('Invalid deletion recovery location');

  if (![transaction.container, transaction.garbagePath].includes(directory) || io.identity(directory) !== transaction.containerIdentity) throw new Error('Deletion recovery directory was replaced');

  if (fs.realpathSync(directory) !== directory) throw new Error('Deletion recovery directory has ambiguous ancestry');
}

function validateFile(transaction, file) {
  if (!validSource(transaction.root, file.source) || path.dirname(file.staged) !== transaction.container || !/^\d+\.staged$/.test(path.basename(file.staged))) throw new Error('Invalid deletion recovery file mapping');
}

function validate(transaction, root, directory) {
  validateIdentity(transaction, root, directory);
  transaction.files.forEach(file => validateFile(transaction, file));
  goalAssets.validate(root, transaction.goalAssets ?? []);

  for (const owner of transaction.ownership) {
    const key = createHash('sha256').update(owner.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (owner.file !== path.join(root, 'conversation-ownership', `${key}.json`)) throw new Error('Invalid deletion ownership mapping');
  }
}

function stagedPath(transaction, file) {
  return path.join(location(transaction), path.basename(file.staged));
}

function committed(transaction) {
  return Boolean(io.exists(transaction.garbagePath)) && io.identity(transaction.garbagePath) === transaction.containerIdentity;
}

function restoreFile(transaction, file) {
  if (file.skipped) return;
  const destination = stagedPath(transaction, file);

  if (!io.exists(destination) && io.exists(file.source)) return;
  io.undo({ source: file.source, destination, identity: file.identity });
}

function retire(transaction) {
  const directory = location(transaction);

  const unexpected = fs.readdirSync(directory).filter(name => name !== 'recovery.json');

  if (unexpected.length) throw new Error(`Unresolved recovery files retained: ${unexpected.join(', ')}`);
  transaction.retiring = true;
  save(transaction);
  fs.rmSync(path.join(directory, 'recovery.json'), { force: true });
  io.sync(directory);
  fs.rmdirSync(directory);
  io.sync(path.dirname(directory));
  records.remove(transaction.root, transaction.container);
}

function rollback(transaction) {
  if (transaction.state === 'rolled-back') {
    retire(transaction);

    return;
  }

  const failures = [];

  for (const file of [...transaction.files].reverse()) {
    try { restoreFile(transaction, file); }
    catch (error) { failures.push(error.message); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
  transaction.state = 'rolled-back';
  save(transaction);
  retire(transaction);
}

function finishOwnership(transaction) {
  for (const owner of transaction.ownership) {
    const current = conversationStorage.read(owner.file);

    if (current === null) continue;

    if (current === owner.after || JSON.parse(current).deleted === true) continue;

    if (current !== owner.before) throw new Error(`Deletion ownership changed; retained: ${owner.file}`);
    conversationStorage.write(owner.file, owner.after);
  }
}

function finish(transaction) {
  transaction.state = 'committed';
  save(transaction);
  finishOwnership(transaction);
  require('./registry-deletion.cjs').forget(transaction.root, transaction.targets);
  goalAssets.finish(transaction, save);

  try { require('./temporary-chat.cjs').cleanupDeleted(transaction.root); }
  catch (error) { console.error(`Deletion committed; temporary folder cleanup will retry: ${error.message}`); }

  for (const file of transaction.files.filter(file => !file.skipped)) {
    const staged = stagedPath(transaction, file);

    if (!io.exists(staged)) continue;

    if (!file.cleanup) {
      if (!io.matches(staged, file.identity)) throw new Error(`Committed deletion recovery data changed; retained: ${staged}`);
      file.cleanup = io.removalPlan(staged);
      save(transaction);
    }

    io.removeOwned(staged, file.cleanup);
  }

  retire(transaction);

  try { require('./restore-receipts.cjs').prune(transaction.root); }
  catch (error) { console.error(`Deletion committed; restore receipt pruning will retry: ${error.message}`); }
}

function discardAllocation(root, directory) {
  if (io.exists(directory)) { fs.rmdirSync(directory); io.sync(path.dirname(directory)); }

  records.remove(root, directory);
}

function recoverRecord(root, entry) {
  const { directory, record: transaction } = entry;

  if (path.dirname(directory) !== path.join(root, 'delete-transactions') || !uuid.test(path.basename(directory))) throw new Error('Invalid registered deletion directory');

  if (!transaction) {
    discardAllocation(root, directory);

    return;
  }

  if (transaction.root !== root || transaction.container !== directory) throw new Error('Invalid registered deletion identity');
  const current = location(transaction);

  if (transaction.retiring === true && !io.exists(current)) {
    records.remove(root, directory);

    return;
  }

  validate(transaction, root, current);

  if (transaction.retiring === true) retire(transaction);

  else if (committed(transaction)) finish(transaction);

  else rollback(transaction);
}

function recover(root) {
  const failures = [];

  for (const entry of records.list(root)) {
    try { recoverRecord(root, entry); }
    catch (error) { failures.push(`${entry.directory}: ${error.message}`); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
}

module.exports = { recover };
