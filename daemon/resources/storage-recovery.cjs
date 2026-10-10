const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverRestorations } = require('./legacy-restore-transaction.cjs');
const { pruneReceipts } = require('./deletion-retention.cjs');

function recoverStorage(root) {
  recoverArchives(root);
  recoverRestorations(root);
  pruneReceipts(root);
}

module.exports = { recoverStorage };
