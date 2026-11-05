// The storage database (sessions.sqlite). Only the modules in session-database/ use SQL; all other code uses the named
// operations here and transaction.
const { isDatabaseChange, databaseExists, readOnlyStorage, transaction, reserve, reserveId, pending, bind, register, isRegistered, movePaths,
  lookup, paths, storageRoot, publication, savePublication, removePublication, publications, markCleanup, cleanupRequest, finishCleanup,
  recoveryRecords, saveRecoveryRecord } = require('./session-database/core.cjs');

module.exports = { isDatabaseChange, databaseExists, readOnlyStorage, transaction, reserve, reserveId, pending, bind, register, isRegistered,
  movePaths, lookup, paths, storageRoot, publication, savePublication, removePublication, publications, markCleanup, cleanupRequest,
  finishCleanup, recoveryRecords, saveRecoveryRecord,
  ...require('./session-database/registry.cjs'),
  ...require('./session-database/storage.cjs'),
  ...require('./session-database/goals.cjs'),
  ...require('./session-database/queue.cjs'),
  ...require('./session-database/transcripts.cjs'),
  ...require('./session-database/settings.cjs') };
