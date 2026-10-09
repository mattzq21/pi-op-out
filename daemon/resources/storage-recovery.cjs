const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverRestorations } = require('./restore-transaction.cjs');
const { recover: recoverForks } = require('./fork-transaction.cjs');
const { recover: recoverPreparations } = require('./fork-preparation.cjs');
const { pruneReceipts } = require('./deletion-retention.cjs');

function recoverStorage(root) {
  require('./worktree-creation.cjs').recover(root);
  recoverArchives(root);
  recoverRestorations(root);
  recoverForks(root);
  recoverPreparations(root);
  pruneReceipts(root);
}

module.exports = { recoverStorage };
