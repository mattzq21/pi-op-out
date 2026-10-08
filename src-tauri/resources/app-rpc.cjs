const { realpathSync, readFileSync, existsSync, openSync, closeSync, fsyncSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createRequire } = require("node:module");

const queuePromptContext = new AsyncLocalStorage();

const goalPromptContext = new AsyncLocalStorage();

const queuePromptScope = Symbol("piop.queue-prompt");

const wrappedSessions = new WeakSet();

const wrappedAgents = new WeakSet();

const wrappedManagers = new WeakSet();

let queueValidation;

class GoalPreparationError extends Error {}

function promptError(command, error, output) {
  const response = { type: "response", id: command.id, command: command.command, success: false, error: error instanceof Error ? error.message : String(error) };

  if (error instanceof GoalPreparationError) response.rejection = "goal_preparation";
  output(response);
}

function syncPath(path, flags) {
  const fd = openSync(path, flags);

  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function isQueuedUserMessage(message) {
  return queueValidation.check(message);
}

async function queueContracts(root) {
  const runtimeRequire = createRequire(join(root, "package.json"));

  const [{ Type }, { Check, Parse }] = await Promise.all([
    import(pathToFileURL(runtimeRequire.resolve("typebox")).href),
    import(pathToFileURL(runtimeRequire.resolve("typebox/value")).href),
  ]);

  const response = Type.Object({ type: Type.Literal("answer_question"), requestId: Type.String(), value: Type.Optional(Type.String()), cancelled: Type.Optional(Type.Boolean()) });
  const prompt = Type.Object({ queueId: Type.String({ minLength: 1 }), message: Type.String(), streamingBehavior: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]), images: Type.Optional(Type.Array(Type.Unknown())), questionResponse: Type.Optional(response), goalSubmissionId: Type.Optional(Type.String()), goalPrepared: Type.Optional(Type.Boolean()) });
  const user = Type.Object({ role: Type.Literal("user"), piopQueueId: Type.String({ minLength: 1 }) });

  return { parse: payload => Parse(prompt, payload), check: message => Check(user, message) };
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
      else if (command?.type === "prompt") void dispatch({ ...command, command: "prompt" });
      else input.write(`${line}\n`);
    }
  });
  stdin.on("end", () => { if (pending) input.write(pending); input.end(); });
}

async function resolveQueuedAnswer(payload, session) {
  if (!payload.questionResponse) return false;
  const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.app-rpc"))?.value;

  if (!emit) throw new Error("Piop app requests are unavailable");
  const request = { command: "answer_question", payload: { ...payload.questionResponse, action: "resolve", queueId: payload.queueId }, ctx: session.extensionRunner.createCommandContext() };
  emit(request);

  if (!request.ready) throw new Error("Question answer resolution is unavailable");
  await request.ready;

  return session.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" && entry.message.piopQueueId === payload.queueId);
}

async function dispatchQueuedPrompt(command, session, output) {
  const payload = queueValidation.parse(command.payload);

  if (await resolveQueuedAnswer(payload, session)) {
    output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition: "handled" } });

    return;
  }

  let preflightSucceeded = false;
  void session.prompt(payload.message, {
    images: payload.images,
    streamingBehavior: payload.streamingBehavior,
    source: "rpc",
    goalSubmissionId: payload.goalSubmissionId,
    goalPrepared: payload.goalPrepared,
    [queuePromptScope]: { session, queueId: payload.queueId, tagged: false },
    preflightResult: (disposition, submittedText) => {
      preflightSucceeded = true;
      output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition, submittedText } });
    },
  }).catch(error => {
    if (!preflightSucceeded) {
      promptError(command, error, output);
    }
  });
}

function dispatchPrompt(command, session, output) {
  let preflightSucceeded = false;
  void session.prompt(command.message, {
    images: command.images, streamingBehavior: command.streamingBehavior, source: "rpc", goalSubmissionId: command.goalSubmissionId,
    preflightResult: (disposition, submittedText) => {
      preflightSucceeded = true;
      output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition, submittedText } });
    },
  }).catch(error => { if (!preflightSucceeded) promptError(command, error, output); });
}

function goalObjective(text, images) {
  const value = text.trimStart().match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();

  return Boolean(value && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ")) || Boolean(images?.length && text.trim() === "/goal");
}

async function prepareGoalPrompt(text, session, goalSubmissionId, images, prepared) {
  if (!goalObjective(text, images) && !prepared) return { message: text };

  try {
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.app-rpc"))?.value;

    if (!emit) throw new Error("Goal prompt preparation is unavailable");
    const request = { command: "prepare_goal_prompt", payload: { message: text, goalSubmissionId, images, prepared }, ctx: session.extensionRunner.createCommandContext() };
    emit(request);

    if (!request.ready) throw new Error("Goal prompt preparation is unavailable");
    const result = await request.ready;

    if (!result?.message) throw new Error("Goal prompt preparation did not produce an objective");

    return result;
  } catch (error) { throw new GoalPreparationError(error instanceof Error ? error.message : String(error)); }
}

function acceptGoalPrompt(prepared) {
  try { prepared.accept(); }
  catch (error) { throw new GoalPreparationError(error instanceof Error ? error.message : String(error)); }
}

function installGoalAcceptance(AgentSession) {
  for (const name of ["_queueSteer", "_queueFollowUp"]) {
    const queue = AgentSession.prototype[name];
    AgentSession.prototype[name] = function (...args) {
      const scope = goalPromptContext.getStore();

      if (scope?.session === this) acceptGoalPrompt(scope.prepared);

      return queue.apply(this, args);
    };
  }

  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function (text, options) {
    const prepared = await prepareGoalPrompt(text, this, options?.goalSubmissionId, options?.images, options?.goalPrepared);
    const goal = Boolean(prepared.goalSubmissionId);

    const preflightResult = disposition => {
      if (goal) {
        if (disposition === "handled") throw new GoalPreparationError("The prepared goal prompt was handled before submission. Restore the objective from saved input recovery.");
        acceptGoalPrompt(prepared);
      }

      options?.preflightResult?.(disposition, goal ? prepared.message : undefined);
    };

    const preparedOptions = goal ? { ...options, preflightResult, goalSubmissionId: prepared.goalSubmissionId, goalPrepared: true, images: undefined, expandPromptTemplates: false } : { ...options, preflightResult };

    return goalPromptContext.run(goal ? { session: this, prepared } : undefined, () => prompt.call(this, prepared.message, preparedOptions));
  };
}

async function dispatch(command, session, output) {
  try {
    if (!session) throw new Error("Piop app requests are unavailable");

    if (command.command === "prompt") {
      dispatchPrompt(command, session, output);

      return;
    }

    if (command.command === "queue_prompt") {
      await dispatchQueuedPrompt(command, session, output);

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
    promptError(command, command.command === "prepare_goal_prompt" ? new GoalPreparationError(error instanceof Error ? error.message : String(error)) : error, output);
  }
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  queueValidation = await queueContracts(root);
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  installGoalAcceptance(AgentSession);

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
