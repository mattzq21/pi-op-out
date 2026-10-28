const key = Symbol.for('piop.mcp-connections');
const listeners = globalThis[key] ??= new Set();
const installed = new WeakSet();

function subscribeConnections(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function installConnectionEvents(Connection) {
  if (installed.has(Connection)) return;
  if (typeof Connection.prototype.changed !== 'function') throw new Error('Pi MCP connection events are unavailable');
  const changed = Connection.prototype.changed;
  Connection.prototype.changed = function (...args) {
    const result = changed.apply(this, args);
    for (const listener of listeners) listener(this);
    return result;
  };
  installed.add(Connection);
}

module.exports = { installConnectionEvents, subscribeConnections };
