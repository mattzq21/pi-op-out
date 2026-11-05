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

function read(root: string, sessionId: string): ConversationChildIndex | undefined {
  const db = tables.connection(root);
  const saved = db.prepare(`SELECT s.session_path, c.complete FROM auxiliary_child_state c
    JOIN sessions s USING(session_id) WHERE c.session_id=?`).get(sessionId);

  if (!saved) return;

  const children = db.prepare(`SELECT c.child_id AS sessionId, coalesce(s.session_path, '') AS sessionPath, c.kind
    FROM auxiliary_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=?`).all(sessionId) as unknown as ConversationChild[];

  return { version: 1, sessionId, sessionPath: String(saved.session_path ?? ''), complete: Boolean(saved.complete), children };
}

function identity(db, sessionId, sessionPath) {
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND (? = '' OR session_path=?)").get(sessionId, sessionPath, sessionPath));
}

function write(db, value) {
  if (!identity(db, value.sessionId, value.sessionPath)) return;
  db.prepare(`INSERT INTO auxiliary_child_state VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET complete=excluded.complete`)
    .run(value.sessionId, Number(value.complete));
  db.prepare('DELETE FROM auxiliary_children WHERE parent_id=?').run(value.sessionId);
  const insert = db.prepare('INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)');

  for (const child of value.children) {
    if (identity(db, child.sessionId, child.sessionPath)) insert.run(value.sessionId, child.sessionId, child.kind);
  }
}

const store = onMainThread('session-child-index.store', (root: string, value: unknown) => {
  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');
  const db = tables.connection(root);

  tables.transaction(db, 'IMMEDIATE', () => write(db, value));
});

function ensure(root, sessionId, sessionPath, complete = false) {
  if (sessionPath) tables.registerPath(root, sessionId, sessionPath);
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
  const db = tables.connection(root);

  tables.transaction(db, 'IMMEDIATE', () => {
    if (!identity(db, parentSessionId, value.sessionPath) || !identity(db, child.sessionId, child.sessionPath)) return;
    db.prepare('INSERT INTO auxiliary_child_state VALUES (?, 0) ON CONFLICT(session_id) DO NOTHING').run(parentSessionId);
    db.prepare(`INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)
      ON CONFLICT(parent_id, child_id) DO UPDATE SET kind=excluded.kind`)
      .run(parentSessionId, child.sessionId, child.kind);
  });
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
function tree(root: string, sessionId: string): string[] {
  const db = tables.connection(root);
  const parent = db.prepare('SELECT parent_id FROM auxiliary_children WHERE child_id=?');
  let top = sessionId;
  const seen = new Set([sessionId]);
  for (let row; (row = parent.get(top)) && !seen.has(row.parent_id);) { top = row.parent_id; seen.add(top); }
  const rows = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT c.child_id FROM auxiliary_children c JOIN tree t ON c.parent_id=t.id)
    SELECT id FROM tree`).all(top);
  return [...new Set([sessionId, ...rows.map(row => row.id as string)])];
}

export { read, store, ensure, add, registerTranscript, initialize, tree };
