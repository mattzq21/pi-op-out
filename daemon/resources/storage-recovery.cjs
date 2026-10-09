const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverRestorations } = require('./restore-transaction.cjs');
const { recover: recoverForks } = require('./fork-transaction.cjs');
const { recover: recoverPreparations } = require('./fork-preparation.cjs');
const { pruneReceipts } = require('./deletion-retention.cjs');
const { recoverSnapshotTemps } = require('./snapshot-recovery.cjs');

function recoverStorage(root) {
  recoverArchives(root);
  recoverRestorations(root);
  recoverForks(root);
  recoverPreparations(root);
  pruneReceipts(root);
  recoverSnapshotTemps(root);
}

module.exports = { recoverStorage };
