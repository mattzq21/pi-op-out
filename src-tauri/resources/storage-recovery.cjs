const { recover: recoverArchives } = require('./archive-transaction.cjs');
const { recover: recoverDeletions } = require('./delete-recovery.cjs');
const { recover: recoverRestorations } = require('./restore-transaction.cjs');

function recoverStorage(root) {
  recoverArchives(root);
  recoverDeletions(root);
  recoverRestorations(root);
}

module.exports = { recoverStorage };
