const stateRecords = require('../piop-storage/session-records.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('../piop-storage/session-publication-io.cjs');
const tables = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

const childSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), kind: Type.String({ minLength: 1 }) });

const indexSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), sessionPath: Type.String(), complete: Type.Boolean(), children: Type.Array(childSchema) });

const parentSchema = Type.Object({ type: Type.Literal('custom'), customType: Type.Literal(stateRecords.AUXILIARY_PARENT), data: Type.Object({ kind: Type.String({ minLength: 1 }), sessionId: Type.String(), parentSessionId: Type.String(), parentSessionPath: Type.Optional(Type.String()) }) });

function read(root, sessionId) { return tables.readChildIndex(root, sessionId); }

const store = onMainThread('session-child-index.store', (root, value) => {
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

const add = onMainThread('session-child-index.add', (root, parentSessionId, parentSessionPath, child) => {
  const value = { version: 1, sessionId: parentSessionId, sessionPath: parentSessionPath ?? '', complete: false, children: [child] };

  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');

  tables.transaction(root, 'IMMEDIATE', () => tables.addIndexedChild(root, parentSessionId, value.sessionPath, child));
});

function registerTranscript(root, sessionPath, body) {
  const entries = stateRecords.merge(sessionPath, body.trim().split('\n').map(JSON.parse));
  const header = entries[0];

  if (!Check(io.headerSchema, header)) throw new Error('Invalid conversation child publication');
  ensure(root, header.id, sessionPath, header.piopChildIndexVersion === 1);

  for (const entry of entries) {
    if (!Check(parentSchema, entry) || entry.data.sessionId !== header.id) continue;
    add(root, entry.data.parentSessionId, entry.data.parentSessionPath, { sessionId: header.id, sessionPath, kind: entry.data.kind });
  }
}

async function initialize(sessionPath, sessionId, fresh) {
  const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

  if (!['sessions', 'archived'].some(area => io.inside(path.join(root, area), sessionPath)) || !io.canonical(path.dirname(sessionPath))) throw new Error('Conversation child index is outside Piop-controlled storage');

  return io.lockedAsync(root, () => {
    if (fresh || read(root, sessionId)) ensure(root, sessionId, sessionPath, fresh);
  });
}

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function tree(root, sessionId) { return tables.sessionTreeIds(root, sessionId); }

module.exports = { read, store, ensure, add, registerTranscript, initialize, tree };
