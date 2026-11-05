const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

// A goal objective longer than LIMIT reaches the agent as one file, named by the digest of its text. The goal rows own
// these files: a file stays while a goal row has its objective, and is written again from that row when it is missing.
const LIMIT = 4000;

const NAME = /^([a-f0-9]{64})\.md(\.[0-9a-f-]{36}\.tmp)?$/;

function directory(root) { return path.join(root, 'goal-files'); }

function digest(objective) { return createHash('sha256').update(objective).digest('hex'); }

function syncDirectory(folder) {
  const descriptor = fs.openSync(folder, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function write(target, objective) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try {
    try { fs.writeFileSync(descriptor, objective); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  syncDirectory(path.dirname(target));
}

// The text that gives objective to the agent. A long objective becomes the path of its file, written when missing.
// collect can remove a file that no goal row has yet, so call it again once the row is saved.
function agentText(root, objective) {
  if ([...objective].length <= LIMIT) return objective;
  const target = path.join(directory(root), digest(objective) + '.md');

  if (!fs.existsSync(target)) write(target, objective);

  return `Read the goal objective file at ${target} before continuing.`;
}

// Removes the goal files whose objective no goal row has. At start (temporary), it also removes unfinished writes.
const collect = onMainThread('goal-files.collect', (root, temporary = false) => {
  let names;

  try { names = fs.readdirSync(directory(root)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const owned = new Set(database.connection(root).prepare('SELECT DISTINCT objective FROM session_goals').all().map(row => digest(row.objective)));

  for (const name of names) {
    const match = NAME.exec(name);

    if (!match || (owned.has(match[1]) && !(temporary && match[2]))) continue;
    fs.rmSync(path.join(directory(root), name), { force: true });
  }
});

module.exports = { agentText, collect, directory };
