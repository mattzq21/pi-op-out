const { realpathSync, readFileSync, existsSync, openSync, closeSync, fsyncSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");

const queuePromptContext = new AsyncLocalStorage();
const queuePromptScope = Symbol("piop.queue-prompt");
const wrappedSessions = new WeakSet();
const wrappedAgents = new WeakSet();
const wrappedManagers = new WeakSet();

function syncPath(path, flags) {
  const fd = openSync(path, flags);

  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function isQueuedUserMessage(message) {
  return message.role === "user" && typeof message.piopQueueId === "string" && Boolean(message.piopQueueId);
}

function installQueueProtocol(session, output) {
  if (!wrappedSessions.has(session)) {
    for (const name of ["prompt", "steer", "followUp"]) {
      const submit = session[name];
      session[name] = function (...args) {
        const scope = name === "prompt" ? args[1]?.[queuePromptScope] : undefined;

        return queuePromptContext.run(scope?.session === this ? scope : undefined, () => submit.apply(this, args));
      };
    }

    wrappedSessions.add(session);
  }

  const agent = session.agent;

  if (!wrappedAgents.has(agent)) {
    for (const name of ["prompt", "steer", "followUp"]) {
      const submit = agent[name];
      agent[name] = function (...args) {
        const scope = queuePromptContext.getStore();

        if (scope && !scope.tagged && scope.session.agent === this) {
          const input = args[0];
          const message = Array.isArray(input) ? input.find(message => message?.role === "user") : input;

          if (message?.role === "user") {
            message.piopQueueId = scope.queueId;
            scope.tagged = true;
          }
        }

        return submit.apply(this, args);
      };
    }

    wrappedAgents.add(agent);
  }

  const manager = session.sessionManager;

  if (!wrappedManagers.has(manager)) {
    const appendMessage = manager.appendMessage;
    const newSessionFiles = new Set();
    manager.appendMessage = function (message, ...args) {
      const file = this.isPersisted() ? this.getSessionFile() : undefined;

      if (file && !existsSync(file)) newSessionFiles.add(file);
      const entryId = appendMessage.call(this, message, ...args);

      if (!file || !entryId || !isQueuedUserMessage(message)) return entryId;

      try {
        syncPath(file, "r+");

        if (newSessionFiles.has(file)) {
          syncPath(dirname(file), "r");
          newSessionFiles.delete(file);
        }
      } catch (error) {
        console.error(`Could not sync queued prompt ${message.piopQueueId}: ${error instanceof Error ? error.message : String(error)}`);
        return entryId;
      }

      output({ type: "queue_consumed", queueId: message.piopQueueId, sessionId: this.getSessionId(), entryId });
      return entryId;
    };
    wrappedManagers.add(manager);
  }
}

function runtimeRoot(executable) {
  const path = realpathSync(isAbsolute(executable) ? executable : execFileSync("which", [executable], { encoding: "utf8" }).trim());
  let root = dirname(path);

  while (true) {
    try {
      if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return root;
    } catch {}

    const parent = dirname(root);

    if (parent === root) throw new Error("Could not locate Pi's JavaScript runtime");
    root = parent;
  }
}

function appInput(dispatch) {
  const stdin = process.stdin;
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input });
  let pending = "";
  stdin.setEncoding("utf8");
  stdin.on("data", chunk => {
    pending += chunk;
    let end;

    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let command;

      try { command = JSON.parse(line); } catch {}

      if (command?.type === "piop_request") void dispatch(command);
      else input.write(`${line}\n`);
    }
  });
  stdin.on("end", () => { if (pending) input.write(pending); input.end(); });
}

async function dispatch(command, session, output) {
  try {
    if (!session) throw new Error("Piop app requests are unavailable");

    if (command.command === "queue_prompt") {
      const payload = command.payload;

      if (typeof payload?.queueId !== "string" || !payload.queueId || typeof payload.message !== "string") {
        throw new Error("queue_prompt requires queueId and message");
      }

      let preflightSucceeded = false;
      void session.prompt(payload.message, {
        images: payload.images,
        streamingBehavior: payload.streamingBehavior,
        source: "rpc",
        [queuePromptScope]: { session, queueId: payload.queueId, tagged: false },
        preflightResult: disposition => {
          preflightSucceeded = true;
          output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition } });
        },
      }).catch(error => {
        if (!preflightSucceeded) {
          output({ type: "response", id: command.id, command: command.command, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }

    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.app-rpc"))?.value;

    if (!emit) throw new Error("Piop app requests are unavailable");
    const request = { command: command.command, payload: command.payload, ctx: session.extensionRunner.createCommandContext() };
    emit(request);

    if (!request.ready) throw new Error(`Unknown app request: ${command.command}`);
    const data = await request.ready;
    output({ type: "response", id: command.id, command: command.command, success: true, data });
  } catch (error) {
    output({ type: "response", id: command.id, command: command.command, success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  const prompt = AgentSession.prototype.prompt;

  AgentSession.prototype.prompt = function (text, options) {
    const value = text.match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();
    const objective = value && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

    return prompt.call(this, text, objective ? { ...options, expandPromptTemplates: false } : options);
  };

  let session;
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    installQueueProtocol(this, output);
    await bind.apply(this, bindings);
    session = this;
  };

  appInput(command => dispatch(command, session, output));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
