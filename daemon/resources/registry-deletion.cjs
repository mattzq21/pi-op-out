const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { onMainThread } = require('./main-thread.cjs');

const targetsSchema = Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String() }));

const forget = onMainThread('registry-deletion.forget', (root, targets) => {
  if (!Check(targetsSchema, targets) || !targets.every(target => path.isAbsolute(target.path))) throw new Error('Invalid committed deletion identities');

  const database = require('./session-database.cjs');
  const { key } = require('./conversation-storage.cjs');

  database.transaction(root, 'IMMEDIATE', () => {
    const ids = targets.filter(target => {
      const current = database.lookup(root, target.sessionId);

      return current === undefined || current === target.path;
    }).map(target => target.sessionId);

    database.removeForgottenSessions(root, ids, ids.map(key));
  });

  const directory = fs.openSync(root, 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
});

module.exports = { forget };
