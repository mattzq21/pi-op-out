import fs from 'node:fs';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { onMainThread } from './main-thread.ts';
import * as SessionDatabase from './session-database.ts';
import * as ConversationStorage from './conversation-storage.ts';

const targetsSchema = Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String() }));

const forget = onMainThread('registry-deletion.forget', (root: string, targets: Static<typeof targetsSchema>) => {
  if (!Check(targetsSchema, targets) || !targets.every(target => path.isAbsolute(target.path))) throw new Error('Invalid committed deletion identities');

  const database = SessionDatabase;
  const { key } = ConversationStorage;

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

export { forget };
