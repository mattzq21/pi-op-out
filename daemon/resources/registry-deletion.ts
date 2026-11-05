import fs from 'node:fs';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { onMainThread } from './main-thread.ts';
import * as SessionDatabase from './session-database.ts';
import * as ConversationStorage from './conversation-storage.ts';

const targetsSchema = Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String() }));

function removeSessionRecords(db, targets) {
  const remove = db.prepare('DELETE FROM transcript_references WHERE session_id=lower(?)');

  for (const target of targets) remove.run(target.sessionId);
}

const forget = onMainThread('registry-deletion.forget', (root: string, targets: Static<typeof targetsSchema>) => {
  if (!Check(targetsSchema, targets) || !targets.every(target => path.isAbsolute(target.path))) throw new Error('Invalid committed deletion identities');

  const database = SessionDatabase;
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    targets = targets.filter(target => {
      const current = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(target.sessionId);

      return !current || current.session_path === target.path;
    });

    for (const target of targets) db.prepare('DELETE FROM queue_origins WHERE session_id=?').run(target.sessionId);

    removeSessionRecords(db, targets);

    for (const target of targets) ConversationStorage.forget(db, target.sessionId);

    for (const target of targets) db.prepare('DELETE FROM sessions WHERE lower(session_id) = ?').run(target.sessionId.toLowerCase());
  });

  const directory = fs.openSync(root, 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
});

export { forget };
