import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';

const MAX_NAME_LENGTH = 50;

function capSessionName(name: string): string { return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trimEnd(); }

function promptName(prompt: string): string { return capSessionName(prompt.replace(/\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g, (_link, label: string) => label.replace(/\\(.)/g, '$1'))); }

function validName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('A conversation name must be text');
  const capped = capSessionName(name);

  if (!capped) throw new Error("Conversation name can't be empty");

  return capped;
}

function sessionName(file: string, sessionId: string): string | undefined { return database.sessionNameOf(database.storageRoot(file), sessionId); }

const nameSession = onMainThread('session-names.nameSession', (file: string, sessionId: string, name: unknown, replace: boolean = true): void => {
  const root = database.storageRoot(file);

  database.transaction(root, 'IMMEDIATE', () => {
    database.register(root, sessionId, file);
    database.saveSessionName(root, sessionId, validName(name), replace);
  });
});

const renameSession = onMainThread('session-names.renameSession', (root: string, sessionId: string, name: unknown): string => {
  return database.transaction(root, 'IMMEDIATE', () => {
    if (!database.isSavedSession(root, sessionId)) throw new Error('Conversation not found');
    database.saveSessionName(root, sessionId, validName(name), true);

    // The name was saved just above in this transaction.
    return database.sessionNameOf(root, sessionId) as string;
  });
});

export { capSessionName, promptName, validName, sessionName, nameSession, renameSession };
