const { realpathSync, readFileSync, existsSync, openSync, closeSync, fsyncSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createRequire } = require("node:module");

const queuePromptContext = new AsyncLocalStorage();

const goalPromptContext = new AsyncLocalStorage();

const releasedPromptContext = new AsyncLocalStorage();

const goalQueueRelease = new WeakMap();

const queuePromptScope = Symbol("piop.queue-prompt");

const wrappedSessions = new WeakSet();

const wrappedAgents = new WeakSet();

const wrappedManagers = new WeakSet();

let queueValidation;

class GoalPreparationError extends Error {}

class GoalQueueBlocked extends Error {}

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

function tagGoalPrompt(agent, name, message) {
  const scope = goalPromptContext.getStore();

  if (name !== "followUp" || scope?.session.agent !== agent) return;
  const goal = currentGoal(scope.session);

  if (goal && message?.role === "user") message.piopGoalId = goal.id;
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

        return releasedPromptContext.run(undefined, () => queuePromptContext.run(scope?.session === this ? scope : undefined, () => submit.apply(this, args)));
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

        tagGoalPrompt(this, name, args[0]);

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
  const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value;

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
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value;

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
    AgentSession.prototype[name] = async function (...args) {
      const scope = goalPromptContext.getStore();

      if (scope?.session === this) acceptGoalPrompt(scope.prepared);

      const result = await queue.apply(this, args);

      if (name === "_queueFollowUp" && scope?.session === this) goalQueueRelease.get(this)?.();

      return result;
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

    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value;

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

const isReview = text => /^\/review(?:\s|$)/.test(text);

const reviewText = message => message.role === "user" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

function currentGoal(session) {
  const entries = session.sessionManager.getEntries();

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (entry.type === "custom" && entry.customType === "piop-goal") return entry.data;
  }

  return null;
}

const hasGoal = session => currentGoal(session) !== null;

function goalBlocksRelease(session, scope) {
  const goal = currentGoal(session);

  return goal && (scope.goalId !== goal.id || goal.status !== "active");
}

function bindReleasedPromptPreparation(session) {
  const streaming = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "isStreaming").get;
  Object.defineProperty(session, "isStreaming", { get() {
    const scope = releasedPromptContext.getStore();

    return scope?.session === this && scope.preparing ? false : streaming.call(this);
  } });

  const input = session._runInputHandlers;
  session._runInputHandlers = function (text, images, ...args) {
    const scope = releasedPromptContext.getStore();

    if (scope?.session === this && scope.inputPending) {
      scope.inputPending = false;

      return Promise.resolve({ text, images });
    }

    return input.call(this, text, images, ...args);
  };

  const run = session._runAgentPrompt;
  session._runAgentPrompt = function (messages) {
    const scope = releasedPromptContext.getStore();

    if (scope?.session === this && !scope.runRequested) {
      if (this._agentRunAbortRequested) throw new Error("Released follow-up preparation was cancelled.");
      if (goalBlocksRelease(this, scope)) throw new GoalQueueBlocked("A goal is holding released follow-ups.");
      scope.preparing = false;
      scope.runRequested = true;
      messages = messages.flatMap(message => {
        if (message.role !== "user") return [message];
        const first = scope.messages[0];
        scope.preparedMessage = first.role === "user" ? { ...first, content: message.content } : first;

        return [scope.preparedMessage, ...scope.messages.slice(1)];
      });
    }

    return run.call(this, messages);
  };
}

function trackReleasedPrompt(session, scope) {
  return session.subscribe(event => {
    if (event.type === "agent_start" && scope.runRequested) scope.started = true;
    if (event.type !== "message_start" || event.message !== scope.preparedMessage) return;
    scope.started = true;
    const original = reviewText(scope.messages[0]);

    if (original === reviewText(event.message)) return;
    const pending = session.getFollowUpMessages();
    const index = pending.indexOf(original);

    if (index !== -1) { pending.splice(index, 1); session._emitQueueUpdate(); }
  });
}

async function releaseQueuedReviews(session, messages, prompt) {
  await session._runAgentPrompt(messages);

  if (!session._agentRunAbortRequested && session.isIdle && !hasGoal(session)) await releaseGoalQueue(session, prompt);
}

function restoreReleasedPrompt(session, scope) {
  if (scope.started) return;
  session.agent.followUpQueue.messages.unshift(...scope.messages);

  if (session._pendingNextTurnMessages !== scope.nextTurnMessages) session._pendingNextTurnMessages.unshift(...scope.nextTurnMessages);
}

async function releaseGoalQueue(session, prompt, messages = session.agent.followUpQueue.drain()) {

  if (!messages.length) return;
  const first = messages[0];

  if (isReview(reviewText(first))) return releaseQueuedReviews(session, messages, prompt);
  const images = first.role === "user" ? first.content.filter(part => part.type === "image") : [];
  const scope = { session, messages, goalId: first.piopGoalId, nextTurnMessages: session._pendingNextTurnMessages, inputPending: true, preparing: true, runRequested: false, started: false };
  const stopTracking = trackReleasedPrompt(session, scope);
  session._agentRunAbortRequested = false;
  session._isAgentRunActive = true;

  try {
    await releasedPromptContext.run(scope, () => prompt.call(session, reviewText(first), { images, source: "rpc", expandPromptTemplates: false }));
  } catch (error) {
    restoreReleasedPrompt(session, scope);
    if (!(error instanceof GoalQueueBlocked)) session.extensionRunner.createContext().ui.notify(String(error), "error");
  } finally {
    stopTracking();

    if (!scope.started && session._isAgentRunActive && !session.agent.activeRun) {
      session._runSystemPromptOptions = undefined;
      session._flushPendingBashMessages();
      session._flushPendingCustomMessages();
      await session._emitAgentSettled();
    }
  }
}

function takeQueuedGoalPrompt(session) {
  const goal = currentGoal(session);

  if (!goal) return undefined;

  if (goal.status !== "active" || session._agentRunAbortRequested) return [];
  const queue = session.agent.followUpQueue.messages;
  const index = queue.findIndex(message => message.piopGoalId === goal.id);

  return index < 0 ? [] : queue.splice(index, 1);
}

function scheduleGoalQueueRelease(session, prompt) {
  let pendingSessionId;
  const schedule = () => setImmediate(() => {
    if (!pendingSessionId) return;

    if (session.sessionManager.getSessionId() !== pendingSessionId) {
      pendingSessionId = undefined;

      return;
    }

    if (!session.isIdle || session._isEmittingAgentSettled) return;
    pendingSessionId = undefined;
    const messages = takeQueuedGoalPrompt(session);

    if (messages?.length === 0) return;
    void releaseGoalQueue(session, prompt, messages);
  });

  session.subscribe(event => {
    if (pendingSessionId && (event.type === "compaction_end" || event.type === "agent_settled")) schedule();
  });

  return () => { pendingSessionId = session.sessionManager.getSessionId(); schedule(); };
}

function bindGoalQueue(session, prompt) {
  bindReleasedPromptPreparation(session);
  const releaseQueue = scheduleGoalQueueRelease(session, prompt);
  goalQueueRelease.set(session, releaseQueue);
  const queue = session.agent.followUpQueue;

  for (const [name, blocked] of [["hasItems", false], ["peek", []]]) {
    const read = queue[name];
    queue[name] = function (...args) {
      return hasGoal(session) ? blocked : read.apply(this, args);
    };
  }

  const manager = session.sessionManager;
  const appendCustomEntry = manager.appendCustomEntry;
  manager.appendCustomEntry = function (customType, data, ...args) {
    const release = customType === "piop-goal" && data === null && hasGoal(session);
    const result = appendCustomEntry.call(this, customType, data, ...args);

    if (release) releaseQueue();

    return result;
  };
}

function bindFollowUpDrain(session) {
  const agent = session.agent;
  const queue = agent.followUpQueue;
  const drain = queue.drain;

  queue.drain = function () {
    if (hasGoal(session)) return [];
    const messages = drain.call(this);
    const review = messages.findIndex(message => isReview(reviewText(message)));

    if (review === -1) return messages;
    const count = review === 0 ? 1 : review;
    this.messages.unshift(...messages.slice(count));

    return messages.slice(0, count);
  };
}

async function executeQueuedReview(session, text, images) {
  const ctx = session.extensionRunner.createCommandContext();
  const signal = ctx.signal;
  const request = { command: "start_review", payload: { args: text.slice(7).trim(), images }, ctx };

  try {
    Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge")).value(request);

    if (!request.ready) throw new Error("Review requests are unavailable");
    await request.ready;
  } catch (error) {
    if (signal?.aborted) return false;
    ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }

  return !signal?.aborted;
}

async function consumeReviews(session, messages) {
  const prompts = [];

  for (const message of messages) {
    const text = reviewText(message);

    if (!isReview(text)) { prompts.push(message); continue; }

    const pending = session.getFollowUpMessages();
    const index = pending.indexOf(text);

    if (index !== -1) pending.splice(index, 1);
    session._emitQueueUpdate();
    const consumed = await executeQueuedReview(session, text, message.content.filter(part => part.type === "image"));

    if (consumed && isQueuedUserMessage(message)) session.sessionManager.appendMessage(message);
  }

  return prompts;
}

async function drainReviews(session, drain) {
  while (true) {
    if (session.agent.signal?.aborted) return [];
    const messages = await drain();

    if (!messages.length) return messages;
    const prompts = await consumeReviews(session, messages);

    if (prompts.length) return prompts;
  }
}

function bindReviewQueue(session) {
  const agent = session.agent;
  bindFollowUpDrain(session);
  const createLoopConfig = agent.createLoopConfig;
  const runPromptMessages = agent.runPromptMessages;

  agent.createLoopConfig = function (...args) {
    const config = createLoopConfig.apply(this, args);
    const followUp = config.getFollowUpMessages;
    config.getFollowUpMessages = () => drainReviews(session, followUp);

    return config;
  };

  agent.runPromptMessages = async function (messages, options) {
    if (options?.skipInitialSteeringPoll || !messages.some(message => isReview(reviewText(message)))) {
      return runPromptMessages.call(this, messages, options);
    }

    let cancelled = false;
    await this.runWithLifecycle(async signal => {
      await consumeReviews(session, messages);
      cancelled = signal.aborted;
    });

    if (!cancelled && this.hasQueuedMessages()) return this.continue();
  };
}

function holdFollowUp(session, options) {
  return options?.streamingBehavior === "followUp" && options?.source === "rpc" && !options?.goalPrepared && hasGoal(session);
}

async function queueHeldFollowUp(session, text, options) {
  if (isReview(text)) {
    await session._queueFollowUp(text, options.images);
    options.preflightResult?.("queued");
  } else if (text.startsWith("/") && options.expandPromptTemplates !== false && await session._tryExecuteExtensionCommand(text)) {
    options.preflightResult?.("handled");
  } else {
    const disposition = await session._queueUserInput(text, options.images, "followUp", options.source);
    options.preflightResult?.(disposition);
  }

  if (!hasGoal(session)) goalQueueRelease.get(session)();
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  const { installAuthStorage, installSessionStorage } = await import("./sdk-storage.mjs");
  const { FileAuthStorageBackend } = await import(pathToFileURL(join(root, "dist/core/auth-storage.js")).href);
  const { SessionManager } = await import(pathToFileURL(join(root, "dist/core/session-manager.js")).href);
  installAuthStorage(FileAuthStorageBackend);
  installSessionStorage(SessionManager);
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];

  if (args.includes("--print")) return import(pathToFileURL(join(root, "dist/cli.js")).href);
  queueValidation = await queueContracts(root);
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function (text, options) {
    if (holdFollowUp(this, options)) return queueHeldFollowUp(this, text, options);

    if (isReview(text) && this.isStreaming) {
      return this._queueFollowUp(text, options?.images).then(() => options?.preflightResult?.("queued"));
    }

    return prompt.call(this, text, options);
  };

  installGoalAcceptance(AgentSession);

  let session;
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    installQueueProtocol(this, output);
    if (session !== this) {
      bindGoalQueue(this, prompt);
      bindReviewQueue(this);
    }
    await bind.apply(this, bindings);

    this.extensionRunner.hasPendingMessagesFn = () => this.getSteeringMessages().length > 0 || (!hasGoal(this) && this.getFollowUpMessages().length > 0);
    session = this;
  };

  appInput(command => dispatch(command, session, output));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
