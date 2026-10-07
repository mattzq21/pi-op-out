const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverDeletions } = require('./delete-recovery.cjs');
const { recover: recoverRestorations } = require('./restore-transaction.cjs');
const { recover: recoverForks } = require('./fork-transaction.cjs');
const { recover: recoverPreparations } = require('./fork-preparation.cjs');
const { pruneReceipts } = require('./deletion-retention.cjs');

function recoverStorage(root) {
  recoverArchives(root);
  recoverDeletions(root);
  recoverRestorations(root);
  recoverForks(root);
  recoverPreparations(root);
  pruneReceipts(root);
}

module.exports = { recoverStorage };
