const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');
const { randomUUID } = require('node:crypto');

function validate(goal) {
  if (goal === null) return;
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id
    || typeof goal.sessionId !== 'string' || !goal.sessionId || typeof goal.objective !== 'string'
    || !goal.objective.trim() || [...goal.objective].length > 4000
    || !['active', 'complete'].includes(goal.status)) throw new Error('Invalid saved goal');
}

function access(file, sessionId, operation) {
  const root = database.storageRoot(file);
  const id = database.goalSessionId(root, file, sessionId);
  if (!id) throw new Error('Goal storage requires a registered conversation');
  return operation(root, id);
}

function read(file, sessionId) {
  return access(file, sessionId, (root, id) => {
    const goal = database.sessionGoal(root, id);
    validate(goal);
    return goal;
  });
}

function restore(file) {
  const root = database.storageRoot(file);
  const id = database.goalSessionId(root, file);
  if (!id) return { goal: null, waitingForInput: false };
  const goal = database.sessionGoal(root, id);
  validate(goal);
  const hold = database.goalInputHold(root, id);
  return { goal, waitingForInput: hold ? JSON.parse(hold)?.data?.held === true : false };
}

const write = onMainThread('goals.write', (file, sessionId, goal) => {
  validate(goal);
  if (goal && goal.sessionId !== sessionId) throw new Error('Goal belongs to another conversation');
  access(file, sessionId, (root, id) => {
    if (!goal) database.removeSessionGoal(root, id);
    else database.saveSessionGoal(root, id, goal);
  });
});

function copy(source, target, sessionId) {
  const goal = read(source);
  if (goal) {
    require('./goal-assets.cjs').retainHistory(database.storageRoot(target), [{ objective: goal.objective }], sessionId, target);
    write(target, sessionId, { ...goal, id: randomUUID(), sessionId });
  }
}

module.exports = { read, restore, write, copy, validate };
