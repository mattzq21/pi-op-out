import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';

const MAX_NAME_LENGTH = 50;

function capSessionName(name: string): string { return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trimEnd(); }

function promptName(prompt) { return capSessionName(prompt.replace(/\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g, (_link, label) => label.replace(/\\(.)/g, '$1'))); }

function validName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('A conversation name must be text');
  const capped = capSessionName(name);

  if (!capped) throw new Error("Conversation name can't be empty");

  return capped;
}

function nameOf(db: database.Connection, sessionId: string): string | undefined { return db.prepare('SELECT name FROM session_names WHERE session_id=?').get(sessionId)?.name as string | undefined; }

function write(db, sessionId, name, replace) {
  db.prepare(`INSERT INTO session_names (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO ${replace ? 'UPDATE SET name=excluded.name' : 'NOTHING'}`).run(sessionId, validName(name));
}

function transaction(root, work) {
  const db = database.connection(root);

  return database.transaction(db, 'IMMEDIATE', () => work(db));
}

function sessionName(file: string, sessionId: string, connection?: database.Connection): string | undefined {
  return nameOf(connection ?? database.connection(database.storageRoot(file)), sessionId);
}

const nameSession = onMainThread('session-names.nameSession', (file: string, sessionId: string, name: string, replace = true): void => {
  transaction(database.storageRoot(file), db => {
    database.register(db, sessionId, file);
    write(db, sessionId, name, replace);
  });
});

const renameSession = onMainThread('session-names.renameSession', (root: string, sessionId: string, name: string): string => {
  return transaction(root, db => {
    if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId)) throw new Error('Conversation not found');
    write(db, sessionId, name, true);

    return nameOf(db, sessionId);
  });
});

export { capSessionName, promptName, validName, sessionName, nameSession, renameSession, nameOf };
