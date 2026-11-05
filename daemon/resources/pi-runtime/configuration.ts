import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { patchMethod } from '../pi/index.ts';
import type { AppRequest } from '../session-broker/index.ts';

const reloadOperations = new WeakMap<object, Promise<void>>();

const configurationOperations = new WeakMap<object, Promise<void>>();

function installReloadLifecycle(AgentSession: typeof PiAgentSession) {
  patchMethod(AgentSession.prototype, "reload", reload => function (this: any, ...args) {
    const previous = reloadOperations.get(this) ?? Promise.resolve();
    const operation = previous.then(() => reload.apply(this, args));
    const settled = operation.then(() => undefined, () => undefined);
    reloadOperations.set(this, settled);
    settled.then(() => { if (reloadOperations.get(this) === settled) reloadOperations.delete(this); });

    return operation;
  });
}

async function afterReload<T>(session: object | undefined, work: () => T | PromiseLike<T>): Promise<T> {
  while (session && reloadOperations.has(session)) await reloadOperations.get(session);

  return work();
}

function serializeConfiguration<T>(session: object, work: () => T | PromiseLike<T>): Promise<T> {
  const previous = configurationOperations.get(session) ?? Promise.resolve();
  const operation = previous.then(work);
  const settled = operation.then(() => undefined, () => undefined);
  configurationOperations.set(session, settled);
  settled.then(() => { if (configurationOperations.get(session) === settled) configurationOperations.delete(session); });

  return operation;
}

function runtimeRequest(session: Pick<PiAgentSession, 'extensionRunner'>, command: string, payload: unknown): Promise<unknown> {
  return afterReload(session, () => {
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value as ((request: AppRequest) => void) | undefined;

    if (!emit) throw new Error("Piop app requests are unavailable");
    const request: AppRequest = { command, payload, ctx: session.extensionRunner.createCommandContext() };
    emit(request);

    if (!request.ready) throw new Error(`Unknown app request: ${command}`);

    return request.ready;
  });
}

export { installReloadLifecycle, afterReload, serializeConfiguration, runtimeRequest };
