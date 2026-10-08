const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-publication-io.cjs');

const childSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), kind: Type.Union([Type.Literal('subagent'), Type.Literal('review')]) });

const indexSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), sessionPath: Type.String(), complete: Type.Boolean(), children: Type.Array(childSchema) });

const parentSchema = Type.Object({ type: Type.Literal('custom'), customType: Type.String(), data: Type.Object({ sessionId: Type.String(), parentSessionId: Type.String(), parentSessionPath: Type.Optional(Type.String()) }) });

function indexPath(root, sessionId) {
  return path.join(root, 'conversation-children', createHash('sha256').update(sessionId).digest('hex') + '.json');
}

function read(root, sessionId) {
  const file = indexPath(root, sessionId);

  if (!io.exists(file)) return;
  const value = JSON.parse(io.read(file).body);

  if (!Check(indexSchema, value) || value.sessionId !== sessionId) throw new Error('Invalid conversation child index');

  return value;
}

function store(root, value) {
  if (!Check(indexSchema, value)) throw new Error('Invalid conversation child index');
  io.mkdir(path.join(root, 'conversation-children'));
  io.write(indexPath(root, value.sessionId), value);
}

function ensure(root, sessionId, sessionPath, complete = false) {
  const previous = read(root, sessionId);

  if (previous && (!sessionPath || previous.sessionPath === sessionPath)) return previous;
  const value = previous ?? { version: 1, sessionId, sessionPath, complete, children: [] };

  if (sessionPath) value.sessionPath = sessionPath;
  store(root, value);

  return value;
}

function add(root, parentSessionId, parentSessionPath, child) {
  const value = read(root, parentSessionId) ?? { version: 1, sessionId: parentSessionId, sessionPath: parentSessionPath ?? '', complete: false, children: [] };
  const previous = value.children.findIndex(item => item.sessionId === child.sessionId);

  if (previous >= 0 && JSON.stringify(value.children[previous]) === JSON.stringify(child)) return;

  if (previous < 0) value.children.push(child);
  else value.children[previous] = child;
  store(root, value);
}

function registerTranscript(root, sessionPath, body) {
  const entries = body.trim().split('\n').map(JSON.parse);
  const header = entries[0];

  if (!Check(io.headerSchema, header)) throw new Error('Invalid conversation child publication');
  ensure(root, header.id, sessionPath, header.piopChildIndexVersion === 1);

  for (const entry of entries) {
    if (!Check(parentSchema, entry) || entry.data.sessionId !== header.id) continue;
    const kind = entry.customType === 'piop-subagent-parent' ? 'subagent' : entry.customType === 'piop-review-parent' ? 'review' : undefined;

    if (kind) add(root, entry.data.parentSessionId, entry.data.parentSessionPath, { sessionId: header.id, sessionPath, kind });
  }
}

async function initialize(sessionPath, sessionId, fresh) {
  const root = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

  if (!['sessions', 'archived'].some(area => io.inside(path.join(root, area), sessionPath)) || !io.canonical(path.dirname(sessionPath))) throw new Error('Conversation child index is outside Piop-controlled storage');

  return io.lockedAsync(root, () => {
    if (fresh || read(root, sessionId)) ensure(root, sessionId, sessionPath, fresh);
  });
}

module.exports = { read, store, ensure, add, registerTranscript, initialize };
