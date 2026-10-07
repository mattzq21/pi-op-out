const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverDeletions } = require('./delete-recovery.cjs');
const { recover: recoverRestorations } = require('./restore-transaction.cjs');
const { recover: recoverForks } = require('./fork-transaction.cjs');
const { recover: recoverPreparations } = require('./fork-preparation.cjs');

function recoverStorage(root) {
  recoverArchives(root);
  recoverDeletions(root);
  recoverRestorations(root);
  recoverForks(root);
  recoverPreparations(root);
}

module.exports = { recoverStorage };
