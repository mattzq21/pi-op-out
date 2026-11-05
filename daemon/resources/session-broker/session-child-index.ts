import * as stateRecords from '../piop-storage/session-records.ts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as io from '../piop-storage/session-publication-io.ts';
import * as tables from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';

export interface ConversationChild {
  sessionId: string;
  sessionPath: string;
  kind: string;
}

export interface ConversationChildIndex {
  version: 1;
  sessionId: string;
  sessionPath: string;
  complete: boolean;
  children: ConversationChild[];
}


const childSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), kind: Type.String({ minLength: 1 }) });

const indexSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), sessionPath: Type.String(), complete: Type.Boolean(), children: Type.Array(childSchema) });

const parentSchema = Type.Object({ type: Type.Literal('custom'), customType: Type.Literal(stateRecords.AUXILIARY_PARENT), data: Type.Object({ kind: Type.String({ minLength: 1 }), sessionId: Type.String(), parentSessionId: Type.String(), parentSessionPath: Type.Optional(Type.String()) }) });

function read(root, sessionId) { return tables.readChildIndex(root, sessionId); }

const store = onMainThread('session-child-index.store', (root: string, value: unknown) => {
  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');

  tables.transaction(root, 'IMMEDIATE', () => tables.saveChildIndex(root, value));
});

function ensure(root, sessionId, sessionPath, complete = false) {
  if (sessionPath) tables.register(root, sessionId, sessionPath);
  const previous = read(root, sessionId);

  if (previous && (!sessionPath || previous.sessionPath === sessionPath)) return previous;
  const value = previous ?? { version: 1, sessionId, sessionPath, complete, children: [] };

  if (sessionPath) value.sessionPath = sessionPath;
  store(root, value);

  return value;
}

const add = onMainThread('session-child-index.add', (root: string, parentSessionId: string, parentSessionPath: string | undefined, child: ConversationChild) => {
  const value = { version: 1, sessionId: parentSessionId, sessionPath: parentSessionPath ?? '', complete: false, children: [child] };

  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');

  tables.transaction(root, 'IMMEDIATE', () => tables.addIndexedChild(root, parentSessionId, value.sessionPath, child));
});

function registerTranscript(root, sessionPath, body) {
  const entries = stateRecords.merge(sessionPath, body.trim().split('\n').map(JSON.parse));
  const header = entries[0];

  if (!Check(io.headerSchema, header)) throw new Error('Invalid conversation child publication');
  ensure(root, header.id, sessionPath, (header as { piopChildIndexVersion?: unknown }).piopChildIndexVersion === 1);

  for (const entry of entries) {
    if (!Check(parentSchema, entry) || entry.data.sessionId !== header.id) continue;
    add(root, entry.data.parentSessionId, entry.data.parentSessionPath, { sessionId: header.id, sessionPath, kind: entry.data.kind });
  }
}

async function initialize(sessionPath: string, sessionId: string, fresh: boolean): Promise<void> {
  const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

  if (!['sessions', 'archived'].some(area => io.inside(path.join(root, area), sessionPath)) || !io.canonical(path.dirname(sessionPath))) throw new Error('Conversation child index is outside Piop-controlled storage');

  return io.lockedAsync(root, () => {
    if (fresh || read(root, sessionId)) ensure(root, sessionId, sessionPath, fresh);
  });
}

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function tree(root: string, sessionId: string): string[] { return tables.sessionTreeIds(root, sessionId); }

export { read, store, ensure, add, registerTranscript, initialize, tree };
