const reloadOperations = new WeakMap();

const configurationOperations = new WeakMap();

function installReloadLifecycle(AgentSession) {
  const reload = AgentSession.prototype.reload;
  AgentSession.prototype.reload = function (...args) {
    const previous = reloadOperations.get(this) ?? Promise.resolve();
    const operation = previous.then(() => reload.apply(this, args));
    const settled = operation.then(() => undefined, () => undefined);
    reloadOperations.set(this, settled);
    settled.then(() => { if (reloadOperations.get(this) === settled) reloadOperations.delete(this); });

    return operation;
  };
}

async function afterReload(session, work) {
  while (reloadOperations.has(session)) await reloadOperations.get(session);

  return work();
}

function serializeConfiguration(session, work) {
  const previous = configurationOperations.get(session) ?? Promise.resolve();
  const operation = previous.then(work);
  const settled = operation.then(() => undefined, () => undefined);
  configurationOperations.set(session, settled);
  settled.then(() => { if (configurationOperations.get(session) === settled) configurationOperations.delete(session); });

  return operation;
}

function runtimeRequest(session, command, payload) {
  return afterReload(session, () => {
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value;

    if (!emit) throw new Error("Piop app requests are unavailable");
    const request = { command, payload, ctx: session.extensionRunner.createCommandContext() };
    emit(request);

    if (!request.ready) throw new Error(`Unknown app request: ${command}`);

    return request.ready;
  });
}

module.exports = { installReloadLifecycle, afterReload, serializeConfiguration, runtimeRequest };
