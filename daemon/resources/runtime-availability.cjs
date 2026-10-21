const installed = new WeakSet();
const waitKey = Symbol.for("piop.wait-for-idle");
const lifetimeKey = Symbol.for("piop.context-lifetime");

function installAvailability(AgentSession) {
  if (installed.has(AgentSession)) return;
  installed.add(AgentSession);
  const bind = AgentSession.prototype._bindExtensionCore;
  const runners = new WeakSet();
  AgentSession.prototype._bindExtensionCore = function (runner) {
    const result = bind.call(this, runner);
    if (!runners.has(runner)) {
      runners.add(runner);
      const lifetime = new AbortController();
      const invalidate = runner.invalidate;
      runner.invalidate = function (...args) {
        lifetime.abort(new Error("Session context was disposed"));
        return invalidate.apply(this, args);
      };
      const createContext = runner.createContext;
      const session = this;
      runner.createContext = function () {
        return Object.defineProperties(createContext.call(this), {
          [waitKey]: { value: () => session.waitForIdle() },
          [lifetimeKey]: { value: lifetime.signal },
        });
      };
    }
    return result;
  };
}

module.exports = { installAvailability };
