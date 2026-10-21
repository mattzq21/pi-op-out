const installed = new WeakSet();
const waitKey = Symbol.for("piop.wait-for-idle");

function installAvailability(AgentSession) {
  if (installed.has(AgentSession)) return;
  installed.add(AgentSession);
  const bind = AgentSession.prototype._bindExtensionCore;
  const runners = new WeakSet();
  AgentSession.prototype._bindExtensionCore = function (runner) {
    const result = bind.call(this, runner);
    if (!runners.has(runner)) {
      runners.add(runner);
      const createContext = runner.createContext;
      const session = this;
      runner.createContext = function () {
        return Object.defineProperty(createContext.call(this), waitKey, { value: () => session.waitForIdle() });
      };
    }
    return result;
  };
}

module.exports = { installAvailability };
