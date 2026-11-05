import { patchMethod } from '../pi/index.ts';

const installed = new WeakSet();
const waitKey = Symbol.for("piop.wait-for-idle");
const lifetimeKey = Symbol.for("piop.context-lifetime");

function installAvailability(AgentSession) {
  if (installed.has(AgentSession)) return;
  const runners = new WeakSet();
  patchMethod(AgentSession.prototype, "_bindExtensionCore", bind => function (this: any, runner) {
    const result = bind.call(this, runner);
    if (!runners.has(runner)) {
      runners.add(runner);
      const lifetime = new AbortController();
      patchMethod(runner, "invalidate", invalidate => function (this: any, ...args) {
        lifetime.abort(new Error("Session context was disposed"));
        return invalidate.apply(this, args);
      });
      const session = this;
      patchMethod(runner, "createContext", createContext => function (this: any) {
        return Object.defineProperties(createContext.call(this), {
          [waitKey]: { value: () => session.waitForIdle() },
          [lifetimeKey]: { value: lifetime.signal },
        });
      });
    }
    return result;
  });
  installed.add(AgentSession);
}

export { installAvailability };
