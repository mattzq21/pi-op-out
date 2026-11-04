const { patchMethod } = require('./pi-patch.cjs');
const key = Symbol.for('piop.mcp-connections');
const listeners = globalThis[key] ??= new Set();
const installed = new WeakSet();

function subscribeConnections(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function installConnectionEvents(Connection) {
  if (installed.has(Connection)) return;
  patchMethod(Connection.prototype, 'changed', changed => function (...args) {
    const result = changed.apply(this, args);
    for (const listener of listeners) listener(this);
    return result;
  });
  installed.add(Connection);
}

module.exports = { installConnectionEvents, subscribeConnections };
