const { addRoot } = require('./storage-inventory-roots.cjs');
const { validateTransfer, transferPath, inspectStage } = require('./diff-transfer-provenance.cjs');

const transferStorage = require('./session-broker/git-diff-transfer-storage.cjs');

const categories = ['diff-transfer-staging', 'unattributed-diff-transfer-staging'];

function stageRecord(profile, key, value, owner, source, discovery) {
  const transfer = validateTransfer(key, value);
  const file = transferPath(profile, transfer);
  let metadata;

  try { metadata = inspectStage(file); }
  catch (error) { discovery.warnings.push(file + ': diff transfer staging unavailable: ' + error.message + '; retained'); }

  if (noFileRecord(metadata, profile, transfer, source, discovery)) return;
  const proven = transfer.owner === owner.sessionId;
  const ownership = proven && metadata ? 'owned' : 'unattributed';
  const owners = [{ ...owner, kind: proven ? 'diff-transfer-source-log-provenance' : 'copied-diff-transfer-log-provenance' }];

  if (!proven) owners.push({ sessionId: transfer.owner, kind: 'diff-transfer-record-provenance' });
  const provenance = 'Committed transfer ownership record in ' + source + '; message: ' + transfer.messageId + '; transfer: ' + transfer.transferId + '; durable prefix: ' + transfer.offset + ' bytes in ' + transfer.nextIndex + ' packets; liveness and reclaimability unknown';
  const record = addRoot(discovery.transfers, file, provenance, ownership, owners);

  if (ownership === 'owned') { record.ownership = ownership; record.identity = metadata.identity; }

  record.state = transfer.committed ? 'committed-awaiting-retirement' : 'unfinished-transfer';
  record.available = Boolean(metadata);
  record.directory = false;
  stageWarnings(record, transfer, metadata, proven, discovery.warnings);
}

function noFileRecord(metadata, profile, transfer, source, discovery) {
  return metadata === null && (databaseStage(profile, transfer, source, discovery) || transfer.committed);
}

function databaseStage(profile, transfer, source, discovery) {
  const row = transferStorage.status(transfer, { profile: () => profile });

  if (!row) return false;

  if (!transfer.committed && (row.size === null || row.size < transfer.offset)) discovery.warnings.push(source + ': database transfer contents are shorter than the saved progress; retained');

  if (row.size > transfer.offset) discovery.warnings.push(source + ': database transfer has bytes beyond the saved progress; retained for retry');

  return true;
}

function stageWarnings(record, transfer, metadata, proven, warnings) {
  if (!proven) warnings.push(record.path + ': source-log session differs from the transfer owner; staging ownership unresolved and contents retained');

  if (!metadata) {
    warnings.push(record.path + ': recorded diff transfer stage is unavailable' + (transfer.offset === 0 ? ' or not yet created' : '') + '; coverage incomplete, source log retained');

    return;
  }

  if (metadata.size < transfer.offset) { record.state = 'incomplete-durable-prefix'; warnings.push(record.path + ': staged bytes are shorter than the durable prefix; measured bytes are incomplete and contents retained'); }

  if (metadata.size > transfer.offset) { record.state = 'uncommitted-tail'; warnings.push(record.path + ': includes bytes beyond the committed transfer progress; all observed blocks counted, contents retained'); }
}

function discoverTransfers(profile, state, owner, source, discovery) {
  for (const [key, value] of Object.entries(state.transfers)) {
    try { stageRecord(profile, key, value, owner, source, discovery); }
    catch (error) { discovery.warnings.push(source + ': diff transfer provenance unavailable: ' + error.message + '; unmatched staging remains unattributed'); }
  }
}

function stageCategory(target, category, metadata, discovery) {
  if (!categories.includes(category) || metadata.isDirectory()) return category;
  const record = discovery.transfers.get(target);
  const identity = metadata.dev + ':' + metadata.ino;

  return record?.ownership === 'owned' && record.identity === identity && metadata.isFile() && metadata.nlink === 1 ? 'diff-transfer-staging' : 'unattributed-diff-transfer-staging';
}

function observeStage(target, category, metadata, discovery) {
  if (!categories.includes(category) || metadata.isDirectory()) return;
  let record = discovery.transfers.get(target);

  if (!record) record = addRoot(discovery.transfers, target, 'File in the Piop git-diff-transfers namespace without a matching readable source-log ownership record; name alone does not prove conversation ownership', 'unattributed');

  if (category === 'unattributed-diff-transfer-staging') {
    record.ownership = 'unattributed';
    discovery.warnings.push(target + ': diff transfer owner or file identity unresolved; contents retained and no cleanup authorized');
  }

  record.available = metadata.isFile();
  record.directory = false;
  record.state ??= 'unattributed-stage';

  return record;
}

module.exports = { discoverTransfers, stageCategory, observeStage };
