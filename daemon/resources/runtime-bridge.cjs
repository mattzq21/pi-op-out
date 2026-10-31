const { realpathSync, readFileSync, existsSync, openSync, closeSync, fsyncSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");

const queuePromptContext = new AsyncLocalStorage();

const queuePromptScope = Symbol("piop.queue-prompt");

const wrappedSessions = new WeakSet();

const wrappedAgents = new WeakSet();

const wrappedManagers = new WeakSet();

const { installReloadLifecycle, afterReload, serializeConfiguration, runtimeRequest } = require("./runtime-configuration.cjs");

const { queuePull } = require("./queue-pull.cjs");

const configurationCommands = new Set(["context_cap_settings", "provider_auth_refresh", "get_agent_configuration", "configure_agents", "select_agent", "fork_after", "fork_and_forget", "prepare_fork"]);

let queueValidation;

function promptError(command, error, output) {
  output({ type: "response", id: command.id, command: command.command, success: false, error: error instanceof Error ? error.message : String(error) });
}

function acceptedPromptError(session, error, output) {
  output({ type: "extension_error", error: error instanceof Error ? error.message : String(error) });

  if (!session.isStreaming) output({ type: "agent_settled", aborted: false });
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

  const prompt = Type.Object({ queueId: Type.String({ minLength: 1 }), message: Type.String(), streamingBehavior: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]), images: Type.Optional(Type.Array(Type.Unknown())), goalSubmissionId: Type.Optional(Type.String()) });
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
            if (scope.submissionId) message.piopSubmissionId = scope.submissionId;
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

function runtimeEvents(output) {
  const pending = new Map();

  const send = (name, data) => new Promise((resolve, reject) => {
    if (typeof name !== "string" || !name) throw new Error("A runtime event needs a name");
    const id = randomUUID();
    pending.set(id, { resolve, reject });

    try { output({ type: "piop_runtime_event", id, name, data }); }
    catch (error) { pending.delete(id); reject(error); }
  });

  const answer = result => {
    const waiter = pending.get(result.id);

    if (!waiter) { console.error(`Piop answered unknown runtime event ${String(result.id)}`); return; }
    pending.delete(result.id);

    if (typeof result.error === "string") waiter.reject(new Error(result.error));
    else waiter.resolve(result.data);
  };

  const close = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Piop stopped before it handled the runtime event"));
    pending.clear();
  };

  Object.defineProperty(globalThis, Symbol.for("piop.runtime-events"), { value: send, configurable: true });

  return { answer, close, send };
}

function appInput(dispatch, events) {
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
      else if (command?.type === "piop_runtime_event_result") events.answer(command);
      else if (command?.type === "prompt") void dispatch({ ...command, command: "prompt" });
      else if (command?.type === "get_commands") void dispatch({ ...command, command: "get_commands" });
      else input.write(`${line}\n`);
    }
  });
  stdin.on("end", () => { events.close(); if (pending) input.write(pending); input.end(); });
}

async function dispatchQueuedPrompt(command, session, output) {
  const payload = queueValidation.parse(command.payload);

  let preflightSucceeded = false;
  void session.prompt(payload.message, {
    images: payload.images,
    streamingBehavior: payload.streamingBehavior,
    source: "rpc",
    [queuePromptScope]: { session, queueId: payload.queueId, submissionId: payload.goalSubmissionId, tagged: false },
    preflightResult: (disposition, submittedText) => {
      preflightSucceeded = true;
      output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition, submittedText } });
    },
  }).catch(error => {
    if (!preflightSucceeded) promptError(command, error, output);
    else acceptedPromptError(session, error, output);
  });
}

/** Passes a message taken from the daemon's queue to Pi. Resolves with Pi's preflight disposition; a later failure of the run it started is reported as a run error. */
function bindQueuePull(session, output) {
  const ask = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value;

  if (!ask) throw new Error("Piop runtime events are unavailable");

  return queuePull(session, {
    ask,
    prompt: (target, item) => promptTaken(target, item, output),
    insert: (target, message) => insertTaken(target, message, output),
    tools: state => {
      const bridge = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"));
      if (!bridge) throw new Error("Piop runtime bridge is unavailable");
      bridge.value({ command: "queue_tools", payload: state, ctx: session.extensionRunner.createCommandContext() });
    },
  });
}

/** Adds a message from the daemon's queue to the context as a custom message that starts or continues a turn. Resolves once Pi took it. */
function insertTaken(session, message, output) {
  const streaming = session.isStreaming;
  const run = session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp" });

  // A run that this message started reports its own failure; a message added to a running turn is added at once.
  if (!streaming) { void run.catch(error => acceptedPromptError(session, error, output)); return Promise.resolve(); }

  return run;
}

function promptTaken(session, item, output) {
  return new Promise((resolve, reject) => {
    let preflightSucceeded = false;
    void session.prompt(item.message, {
      images: item.images,
      streamingBehavior: item.behavior,
      source: "rpc",
      [queuePromptScope]: { session, queueId: item.id, submissionId: item.goalSubmissionId, tagged: false },
      preflightResult: disposition => { preflightSucceeded = true; resolve(disposition); },
    }).catch(error => {
      if (!preflightSucceeded) reject(error);
      else acceptedPromptError(session, error, output);
    });
  });
}

function dispatchPrompt(command, session, output) {
  let preflightSucceeded = false;
  void session.prompt(command.message, {
    images: command.images, streamingBehavior: command.streamingBehavior, source: "rpc",
    preflightResult: (disposition, submittedText) => {
      preflightSucceeded = true;
      output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition, submittedText } });
    },
  }).catch(error => {
    if (!preflightSucceeded) promptError(command, error, output);
    else acceptedPromptError(session, error, output);
  });
}

/**
 * Runs the latest failed or stopped response again, the same way Pi's automatic retry does. The failed attempt stays in the transcript,
 * hidden from the model, and the run continues from the message before it, so the prompt is not sent twice.
 * Pi has no public continue call, so this repeats the run loop of AgentSession._startRun.
 */
function dispatchRetry(command, session, output) {
  const entryId = command.payload?.entryId;

  if (typeof entryId !== "string" || !entryId) throw new Error("Select a response to retry");

  if (session.isStreaming || session.isCompacting) throw new Error("Wait for the current response to finish before retrying");
  const failed = session._findLastAssistantMessage();

  if (!failed || (failed.stopReason !== "error" && failed.stopReason !== "aborted") || session._findPersistedMessageEntryId(failed) !== entryId) throw new Error("Only the latest failed or stopped response can be retried");
  session._isAgentRunActive = true;
  session._agentRunAbortRequested = false;

  try {
    session._omitRecoveryAttempt(failed);
    session._recordSelection();
  } catch (error) {
    session._isAgentRunActive = false;
    session._resolveIdleWaitIfIdle();
    throw error;
  }

  output({ type: "response", id: command.id, command: command.command, success: true, data: null });
  void continueRun(session, failed).catch(error => acceptedPromptError(session, error, output));
}

/**
 * Gives the retried run the prompt and tools that extensions set when a run starts. Without this the run keeps Pi's default prompt.
 * Messages that handlers add are dropped, because the run they belong to already received them.
 */
async function prepareRetriedRun(session, failed) {
  const messages = session.agent.state.messages;
  const end = messages.indexOf(failed);
  const start = (end < 0 ? messages : messages.slice(0, end)).findLast(message => message.role === "user" || message.role === "custom");
  if (!start) throw new Error("The retried response has no message that started it");
  const trigger = start.role === "custom" ? { messageType: "custom", message: start } : typeof start.content === "string"
    ? { messageType: "user", prompt: start.content }
    : { messageType: "user", prompt: start.content.filter(part => part.type === "text").map(part => part.text).join("\n"), images: start.content.filter(part => part.type === "image") };
  const base = session._baseSystemPromptOptions;
  const toolsBefore = base.selectedTools;
  const result = await session._extensionRunner.emitBeforeAgentStart(trigger, base);
  const tools = result.systemPromptOptions.selectedTools;
  if (tools.length === toolsBefore.length && tools.every((name, index) => name === toolsBefore[index])) result.systemPromptOptions.selectedTools = session.getActiveToolNames();
  const update = session._preparePromptAndToolLoadout(result.systemPromptOptions);
  session._runSystemPromptOptions = result.systemPromptOptions;
  if (!update) return;
  session.sessionManager.appendMessage(update);
  session._refreshFinalizedContext();
}

async function continueRun(session, failed) {
  session._failedResponse = failed;
  session._pendingToolNames.clear();

  try {
    await prepareRetriedRun(session, failed);
    if (session._agentRunAbortRequested) return;
    await session.agent.continue();

    while (!session._agentRunAbortRequested) {
      if (await session._handlePostAgentRun()) {
        if (session._agentRunAbortRequested) break;
        await session.agent.continue();
        continue;
      }

      if (session._agentRunAbortRequested || !(await session._runBeforeSettleBoundary()) || session._agentRunAbortRequested) break;
      await session.agent.continue();
    }
  } finally {
    if (session._agentRunAbortRequested) session._finishCancelledRetry();
    session._failedResponse = undefined;
    session._runSystemPromptOptions = undefined;
    session._flushPendingBashMessages();
    session._flushPendingCustomMessages();
    await session._emitAgentSettled();
  }
}

async function dispatch(command, currentSession, sessionReady, output) {
  try {
    if (!currentSession()) await sessionReady;
    const session = currentSession();
    const work = () => afterReload(currentSession(), () => dispatchReady(command, currentSession(), output));

    if (session && configurationCommands.has(command.command)) await serializeConfiguration(session, work);
    else await work();
  } catch (error) { promptError(command, error, output); }
}

async function dispatchReady(command, session, output) {
  try {
    if (!session) throw new Error("Piop app requests are unavailable");

    if (command.command === "prompt") {
      dispatchPrompt(command, session, output);

      return;
    }

    if (command.command === "retry_response") {
      dispatchRetry(command, session, output);

      return;
    }

    if (command.command === "queue_prompt") {
      await dispatchQueuedPrompt(command, session, output);

      return;
    }

    if (command.command === "queue_offer") {
      // Extensions that wait inside a run, such as await_subagents, end their wait for a new user message.
      if (bindQueuePull(session, output).setOffer(command.payload)) {
        const bridge = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"));
        if (!bridge) throw new Error("Piop runtime bridge is unavailable");
        bridge.value({ command: "queue_offered", payload: null, ctx: session.extensionRunner.createCommandContext() });
      }
      output({ type: "response", id: command.id, command: command.command, success: true, data: null });

      return;
    }

    if (command.command === "get_commands") {
      output({ type: "response", id: command.id, command: command.command, success: true, data: { commands: await listCommands(session) } });

      return;
    }

    const data = await runtimeRequest(session, command.command, command.payload);
    output({ type: "response", id: command.id, command: command.command, success: true, data });
  } catch (error) {
    promptError(command, error, output);
  }
}

/** Pi's command list, with the argument options of each extension command. Options come from the command's argument completions for an empty argument. */
async function listCommands(session) {
  const commands = [];

  for (const command of session.extensionRunner.getRegisteredCommands()) {
    commands.push({ name: command.invocationName, description: command.description, source: "extension", sourceInfo: command.sourceInfo, options: await commandOptions(session, command) });
  }

  for (const template of session.promptTemplates) commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });

  for (const skill of session.resourceLoader.getSkills().skills) commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });

  return commands;
}

async function commandOptions(session, command) {
  if (!command.getArgumentCompletions) return undefined;

  try {
    const items = await command.getArgumentCompletions("");

    return items?.map(item => ({ value: item.value, label: item.label, description: item.description }));
  } catch (error) {
    session.extensionRunner.createContext().ui.notify(`/${command.invocationName} options failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** Sends the extension commands of this Pi to its Piop host, which saves them for chats that have not started Pi yet. */
async function reportCommands(session) {
  try {
    const commands = (await listCommands(session)).filter(command => command.source === "extension").map(({ name, description, options }) => ({ name, description, options }));
    await Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events")).value("commands_available", { commands });
  } catch (error) { console.error(`Piop could not save the commands of this Pi: ${error instanceof Error ? error.message : String(error)}`); }
}

if (process.env.PIOP_COMMAND_POLICY === undefined) throw new Error("Piop command policy is missing");

const commandPolicy = JSON.parse(process.env.PIOP_COMMAND_POLICY);

/** Commands of enabled plugins that wait in the follow-up queue and run in order when the conversation reaches them. They never reach the model. */
const queuedCommands = new Set(commandPolicy.queued);

/** Commands of disabled plugins, with the error to show. They are rejected so they never reach the model as text. */
const disabledCommands = new Map(Object.entries(commandPolicy.disabled));

/** The slash command at the start of a message, without the slash. Matches commandName in the daemon. */
const commandName = text => /^\/(\S+)/.exec(text)?.[1];

const queuedCommand = text => queuedCommands.has(commandName(text));

const userText = message => message.role === "user" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

function bindFollowUpDrain(session) {
  const agent = session.agent;
  const queue = agent.followUpQueue;
  const drain = queue.drain;

  queue.drain = function () {
    const messages = drain.call(this);
    const queued = messages.findIndex(message => queuedCommand(userText(message)));

    if (queued === -1) return messages;
    const count = queued === 0 ? 1 : queued;
    this.messages.unshift(...messages.slice(count));

    return messages.slice(0, count);
  };
}

function executeQueuedCommand(session, text, images) {
  return afterReload(session, () => executeQueuedCommandReady(session, text, images));
}

async function executeQueuedCommandReady(session, text, images) {
  const ctx = session.extensionRunner.createCommandContext();
  const signal = ctx.signal;
  const command = text.split(/\s/, 1)[0].slice(1);
  const request = { command: "run_queued_command", payload: { command, args: text.slice(command.length + 1).trim(), images }, ctx };

  try {
    Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge")).value(request);

    if (!request.ready) throw new Error(`/${command} is unavailable`);
    await request.ready;
  } catch (error) {
    if (signal?.aborted) return false;
    ctx.ui.notify(`/${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }

  return !signal?.aborted;
}

async function consumeQueuedCommands(session, messages) {
  const prompts = [];

  for (const message of messages) {
    const text = userText(message);

    if (!queuedCommand(text)) { prompts.push(message); continue; }

    const pending = session.getFollowUpMessages();
    const index = pending.indexOf(text);

    if (index !== -1) pending.splice(index, 1);
    session._emitQueueUpdate();

    if (compactionText(text)) {
      session[reachedCompaction] = { text, message };
      break;
    }

    const consumed = await executeQueuedCommand(session, text, message.content.filter(part => part.type === "image"));

    if (consumed && isQueuedUserMessage(message)) session.sessionManager.appendMessage(message);
  }

  return prompts;
}

async function drainQueuedCommands(session, drain) {
  while (true) {
    if (session.agent.signal?.aborted || session[reachedCompaction]) return [];
    const messages = await drain();

    if (!messages.length) return messages;
    const prompts = await consumeQueuedCommands(session, messages);

    if (prompts.length || session[reachedCompaction]) return prompts;
  }
}

const compactionText = text => commandName(text) === "compact";

/** The queued /compact that the run reached. The run compacts after its turn ends, before it takes the next queued message. */
const reachedCompaction = Symbol("piop.reachedCompaction");

/** Settles when a queued compaction ends. Prompts that arrive meanwhile wait for it, because Pi refuses prompts during a manual compaction. */
const runningCompaction = Symbol("piop.runningCompaction");

/**
 * Compacts at the position of a queued /compact. Pi's compact() stops the agent run first; here the run reached the compaction in order,
 * so that one stop is skipped. A later Stop from the user still stops the compaction and the run.
 */
async function runQueuedCompaction(session, reached, output) {
  const instructions = reached.text.slice("/compact".length).trim() || undefined;
  let finish;
  session[runningCompaction] = new Promise(resolve => { finish = resolve; });
  session.abort = async function () { delete session.abort; };

  try { await session.compact(instructions); } catch (error) {
    console.error(`Queued compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (Object.hasOwn(session, "abort")) delete session.abort;
    session[runningCompaction] = undefined;
    finish();
  }

  if (isQueuedUserMessage(reached.message)) output({ type: "queue_consumed", queueId: reached.message.piopQueueId, sessionId: session.sessionManager.getSessionId(), entryId: null });
}

function bindQueuedCompaction(session, output) {
  const post = session._handlePostAgentRun;

  session._handlePostAgentRun = async function () {
    const reached = this[reachedCompaction];

    if (!reached) return post.call(this);
    this[reachedCompaction] = undefined;

    // A stop before the compaction starts keeps it first in the queue.
    if (this._agentRunAbortRequested) {
      this.agent.followUpQueue.messages.unshift(reached.message);
      this.getFollowUpMessages().unshift(reached.text);
      this._emitQueueUpdate();

      return post.call(this);
    }
    this._lastAssistantMessage = undefined;
    await runQueuedCompaction(this, reached, output);

    return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
  };
}

function bindQueuedCommands(session, output) {
  const agent = session.agent;
  bindFollowUpDrain(session);
  bindQueuedCompaction(session, output);
  const createLoopConfig = agent.createLoopConfig;
  const runPromptMessages = agent.runPromptMessages;

  agent.createLoopConfig = function (...args) {
    const config = createLoopConfig.apply(this, args);
    const followUp = config.getFollowUpMessages;
    config.getFollowUpMessages = () => drainQueuedCommands(session, followUp);

    return config;
  };

  agent.runPromptMessages = async function (messages, options) {
    if (options?.skipInitialSteeringPoll || !messages.some(message => queuedCommand(userText(message)))) {
      return runPromptMessages.call(this, messages, options);
    }

    let cancelled = false;
    await this.runWithLifecycle(async signal => {
      await consumeQueuedCommands(session, messages);
      cancelled = signal.aborted;
    });

    if (!cancelled && !session[reachedCompaction] && this.hasQueuedMessages()) return this.continue();
  };
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  const { installRuntimeStorage } = await import("./sdk-storage.mjs");
  const { installStorage } = await import("./piop-storage/bootstrap.mjs");
  await installRuntimeStorage(root);
  await installStorage(root);
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];

  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { McpServerConnection } = await import(pathToFileURL(join(root, "dist/extensions/mcp/runtime.js")).href);
  require("./mcp-connections.cjs").installConnectionEvents(McpServerConnection);
  require("./runtime-availability.cjs").installAvailability(AgentSession);

  queueValidation = await queueContracts(root);
  installReloadLifecycle(AgentSession);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function (text, options) {
    const disabled = disabledCommands.get(commandName(text));

    if (disabled !== undefined) throw new Error(disabled);

    if (this[runningCompaction]) await this[runningCompaction];

    if (queuedCommand(text) && this.isStreaming) {
      return this._queueFollowUp(text, options?.images).then(() => options?.preflightResult?.("queued"));
    }

    return prompt.call(this, text, options);
  };

  let session;
  let markSessionReady;
  const sessionReady = new Promise(resolve => { markSessionReady = resolve; });
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    installQueueProtocol(this, output);
    bindQueuePull(this, output);

    if (session !== this) bindQueuedCommands(this, output);

    await bind.apply(this, bindings);

    session = this;
    markSessionReady();
    const bridge = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"));
    if (!bridge) throw new Error("Piop runtime bridge is unavailable");
    bridge.value({ command: "session_ready", payload: null, ctx: this.extensionRunner.createCommandContext() });
    void reportCommands(this);
  };

  appInput(command => dispatch(command, () => session, sessionReady, output), runtimeEvents(output));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

module.exports = { continueRun };
