const fs = require('node:fs');

function validate(goal) {
  if (goal === null) return;
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id
    || typeof goal.sessionId !== 'string' || !goal.sessionId || typeof goal.objective !== 'string'
    || !goal.objective.trim() || [...goal.objective].length > 4000
    || !['active', 'paused', 'complete'].includes(goal.status)) throw new Error('Invalid saved goal');
}

function current(branch) {
  const entry = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'piop-goal');
  const goal = entry ? entry.data : null;
  validate(goal);
  return goal === null ? null : structuredClone(goal);
}

function read(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const tail = lines.pop();
  if (tail) console.warn(`${file}: last write was interrupted; ignored ${Buffer.byteLength(tail)} bytes`);
  const entries = lines.filter(Boolean).map(line => JSON.parse(line));
  const indexed = new Map(entries.filter(entry => entry.type !== 'session').map(entry => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  let entry = entries.findLast(entry => entry.type !== 'session');
  while (entry) {
    if (seen.has(entry.id)) throw new Error('Cycle in goal transcript');
    seen.add(entry.id);
    branch.push(entry);
    if (entry.parentId && !indexed.has(entry.parentId)) throw new Error('Missing goal transcript parent');
    entry = indexed.get(entry.parentId);
  }
  return current(branch.reverse());
}

module.exports = { current, read, validate };
