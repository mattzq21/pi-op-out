const { existsSync, openSync, closeSync, fsyncSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
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

const { supportedPi } = require("./pi-runtime.cjs");

const { patchMethod, requireMethods } = require("./pi-patch.cjs");

// Pi takes its storage channel before it starts any program, so those programs do not get it.
require("./storage-channel.cjs").claim();

const configurationCommands = new Set(["context_cap_settings", "provider_auth_refresh", "select_agent", "set_chat_agent", "fork_after", "rewind_message", "prepare_fork"]);

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
      patchMethod(session, name, submit => function (...args) {
        const scope = name === "prompt" ? args[1]?.[queuePromptScope] : undefined;

        return queuePromptContext.run(scope?.session === this ? scope : undefined, () => submit.apply(this, args));
      });
    }

    wrappedSessions.add(session);
  }

  const agent = session.agent;

  if (!wrappedAgents.has(agent)) {
    for (const name of ["prompt", "steer", "followUp"]) {
      patchMethod(agent, name, submit => function (...args) {
        const scope = queuePromptContext.getStore();

        if (scope && !scope.tagged && scope.session.agent === this) {
          const input = args[0];
          const message = Array.isArray(input) ? input.find(message => message?.role === "user") : input;

          if (message?.role === "user") {
            if (scope.queueId) message.piopQueueId = scope.queueId;
            if (scope.submissionId) message.piopSubmissionId = scope.submissionId;
            scope.tagged = true;
          }
        }

        return submit.apply(this, args);
      });
    }

    wrappedAgents.add(agent);
  }

  const manager = session.sessionManager;

  if (!wrappedManagers.has(manager)) {
    const newSessionFiles = new Set();
    patchMethod(manager, "appendMessage", appendMessage => function (message, ...args) {
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
    });

    wrappedManagers.add(manager);
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

      try { command = JSON.parse(line); } catch (error) { console.error("Piop runtime bridge ignored an invalid command line: " + error.message); }

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
    steer: count => {
      const bridge = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"));
      if (!bridge) throw new Error("Piop runtime bridge is unavailable");
      bridge.value({ command: "queue_steer", payload: { steer: count }, ctx: session.extensionRunner.createCommandContext() });
    },
  });
}

function insertTaken(session, message, output) {
  const streaming = session.isStreaming;
  const run = session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp" });

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
    ...(typeof command.goalSubmissionId === "string" && command.goalSubmissionId ? { [queuePromptScope]: { session, submissionId: command.goalSubmissionId, tagged: false } } : {}),
    preflightResult: (disposition, submittedText) => {
      preflightSucceeded = true;
      output({ type: "response", id: command.id, command: command.command, success: true, data: { disposition, submittedText } });
    },
  }).catch(error => {
    if (!preflightSucceeded) promptError(command, error, output);
    else acceptedPromptError(session, error, output);
  });
}

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

const INTERRUPTED_TOOL = "The Piop daemon stopped before this tool call finished. Its result is unknown; check its effects before you repeat it.";

function dispatchResume(command, session, output) {
  const respond = state => output({ type: "response", id: command.id, command: command.command, success: true, data: { state } });
  if (session.isStreaming || session.isCompacting) return respond("running");
  const messages = session.agent.state.messages;
  const index = messages.findLastIndex(message => message.role === "assistant");
  const calls = index < 0 ? [] : messages[index].content.filter(part => part.type === "toolCall");
  const answered = new Set(messages.slice(index + 1).filter(message => message.role === "toolResult").map(message => message.toolCallId));
  const last = messages.at(-1);
  if (!last || last.role === "system" || (last.role === "assistant" && !calls.length)) return respond("finished");
  session._isAgentRunActive = true;
  session._agentRunAbortRequested = false;
  try {
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      session.sessionManager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: INTERRUPTED_TOOL }], isError: true, timestamp: Date.now() });
    }
    session._refreshFinalizedContext();
  } catch (error) {
    session._isAgentRunActive = false;
    session._resolveIdleWaitIfIdle();
    throw error;
  }
  respond("resumed");
  void continueRun(session, undefined).catch(error => acceptedPromptError(session, error, output));
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

    if (command.command === "resume_interrupted") {
      dispatchResume(command, session, output);

      return;
    }

    if (command.command === "queue_prompt") {
      await dispatchQueuedPrompt(command, session, output);

      return;
    }

    if (command.command === "queue_offer") {
      bindQueuePull(session, output).setOffer(command.payload);
      output({ type: "response", id: command.id, command: command.command, success: true, data: null });

      return;
    }

    if (command.command === "prompt_preview") {
      output({ type: "response", id: command.id, command: command.command, success: true, data: await previewPrompt(session) });

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

function previewText(content) {
  if (typeof content === "string") return content;

  return content.map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
}

function previewSystemText(message, leading) {
  const sections = Object.entries(message.sections ?? {});
  const parts = [previewText(message.content)];

  for (const [name, value] of sections) {
    if (leading) { if (value !== null) parts.push(value); }
    else parts.push(value === null ? `Removed system prompt section "${name}".` : `Updated system prompt section "${name}":\n\n${value}`);
  }

  return parts.filter(part => part.length > 0).join("\n\n");
}

function previewMessage(message, index) {
  return { role: message.role, text: message.role === "system" ? previewSystemText(message, index === 0) : previewText(message.content) };
}

// Every place where the request declares tools: a "tools" list in a request field, or a request item that
// adds tools, such as an "additional_tools" item in the input or an Anthropic "tool_addition" block.
function requestTools(payload, declared) {
  const found = [];
  const visit = (value, place, item) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, `${place}[${index}]`, true)); return; }

    if (value === null || typeof value !== "object") return;

    if (item && (Array.isArray(value.tools) || value.type === "tool_addition")) { found.push({ place, json: JSON.stringify(value, null, 2) }); return; }

    if (Array.isArray(value.tools)) found.push({ place: place ? `${place}.tools` : "tools", json: JSON.stringify(value.tools, null, 2) });

    for (const [key, entry] of Object.entries(value)) if (key !== "tools") visit(entry, place ? `${place}.${key}` : key, false);
  };
  visit(payload, "", false);

  if (declared && !found.length) throw new Error("The prompt preview could not find the tools in the model request");

  return found;
}

// Runs the first prompt until the provider has built its request, and returns everything before the user's
// message. Providers hand the request to onPayload before they send it; the preview stops it there.
async function previewPrompt(session) {
  if (process.env.PIOP_PROMPT_PREVIEW !== "1") throw new Error("Only a prompt preview runtime can build a prompt preview");
  const marker = `Prompt preview ${randomUUID()}`;
  const agent = session.agent;
  const transform = agent.onPayload;
  let transcript;
  let built;
  const request = new Promise(resolve => { built = resolve; });
  patchMethod(agent, "streamFunction", stream => (model, context, options) => {
    transcript ??= { model: `${model.provider}/${model.id}`, messages: context.messages };

    return stream(model, context, options);
  });
  agent.onPayload = async (payload, model) => {
    const sent = transform ? (await transform(payload, model)) ?? payload : payload;
    built({ ...transcript, payload: sent });
    throw new Error("The prompt preview stops before the model request");
  };
  const run = session.prompt(marker).then(() => {
    const failure = agent.state.messages.findLast(message => message.role === "assistant")?.errorMessage;
    throw new Error(failure ? `The agent could not start: ${failure}` : "The agent did not start a model request");
  });
  run.catch(() => {});
  const captured = await Promise.race([request, run]);
  const end = captured.messages.findLastIndex(message => message.role === "user" && previewText(message.content).includes(marker));

  if (end < 0) throw new Error("The prompt preview could not find its message in the model request");
  const messages = captured.messages.slice(0, end);

  return { model: captured.model, messages: messages.map(previewMessage), tools: requestTools(captured.payload, messages.some(message => message.toolsAdded?.length)) };
}

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

async function reportCommands(session) {
  try {
    const commands = (await listCommands(session)).filter(command => command.source === "extension").map(({ name, description, options }) => ({ name, description, options }));
    await Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events")).value("commands_available", { commands });
  } catch (error) { console.error(`Piop could not save the commands of this Pi: ${error instanceof Error ? error.message : String(error)}`); }
}

if (process.env.PIOP_COMMAND_POLICY === undefined) throw new Error("Piop command policy is missing");

const commandPolicy = JSON.parse(process.env.PIOP_COMMAND_POLICY);

const queuedCommands = new Set(commandPolicy.queued);

const queuedWithPrompt = new Set(commandPolicy.queuedWithPrompt);

const imageCommands = new Set(commandPolicy.withImages);

const disabledCommands = new Map(Object.entries(commandPolicy.disabled));

const commandName = text => /^\/(\S+)/.exec(text)?.[1];

const queuedCommand = text => queuedCommands.has(commandName(text)) || (queuedWithPrompt.has(commandName(text)) && /^\/\S+\s+\S/.test(text.trimStart()));

const userText = message => message.role === "user" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

function bindFollowUpDrain(session) {
  const agent = session.agent;
  const queue = agent.followUpQueue;

  patchMethod(queue, "drain", drain => function () {
    const messages = drain.call(this);
    const queued = messages.findIndex(message => queuedCommand(userText(message)));

    if (queued === -1) return messages;
    const count = queued === 0 ? 1 : queued;
    this.messages.unshift(...messages.slice(count));

    return messages.slice(0, count);
  }, "Agent follow-up queue");
}

function executePluginCommand(session, text, images) {
  return afterReload(session, () => executePluginCommandReady(session, text, images));
}

async function executePluginCommandReady(session, text, images) {
  const ctx = session.extensionRunner.createCommandContext();
  const signal = ctx.signal;
  const command = text.split(/\s/, 1)[0].slice(1);
  const request = { command: "run_command", payload: { command, args: text.slice(command.length + 1).trim(), images }, ctx };

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

async function consumeQueuedCommands(session, messages, output) {
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

    const consumed = await executePluginCommand(session, text, message.content.filter(part => part.type === "image"));

    if (consumed && isQueuedUserMessage(message)) output({ type: "queue_consumed", queueId: message.piopQueueId, sessionId: session.sessionManager.getSessionId(), entryId: null });
  }

  return prompts;
}

async function drainQueuedCommands(session, drain, output) {
  while (true) {
    if (session.agent.signal?.aborted || session[reachedCompaction]) return [];
    const messages = await drain();

    if (!messages.length) return messages;
    const prompts = await consumeQueuedCommands(session, messages, output);

    if (prompts.length || session[reachedCompaction]) return prompts;
  }
}

const compactionText = text => commandName(text) === "compact";

const reachedCompaction = Symbol("piop.reachedCompaction");

const runningCompaction = Symbol("piop.runningCompaction");

async function runQueuedCompaction(session, reached, output) {
  const instructions = reached.text.slice("/compact".length).trim() || undefined;
  let finish;
  session[runningCompaction] = new Promise(resolve => { finish = resolve; });
  patchMethod(session, "abort", () => async function () { delete session.abort; });

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
  patchMethod(session, "_handlePostAgentRun", post => async function () {
    const reached = this[reachedCompaction];

    if (!reached) return post.call(this);
    this[reachedCompaction] = undefined;

    if (this._agentRunAbortRequested) {
      this.agent.followUpQueue.messages.unshift(reached.message);
      this.getFollowUpMessages().unshift(reached.text);
      this._emitQueueUpdate();

      return post.call(this);
    }
    this._lastAssistantMessage = undefined;
    await runQueuedCompaction(this, reached, output);

    return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
  });
}

function bindQueuedCommands(session, output) {
  const agent = session.agent;
  bindFollowUpDrain(session);
  bindQueuedCompaction(session, output);

  patchMethod(agent, "createLoopConfig", createLoopConfig => function (...args) {
    const config = createLoopConfig.apply(this, args);
    patchMethod(config, "getFollowUpMessages", followUp => () => drainQueuedCommands(session, followUp, output), "Agent loop config");

    return config;
  });

  patchMethod(agent, "runPromptMessages", runPromptMessages => async function (messages, options) {
    if (options?.skipInitialSteeringPoll || !messages.some(message => queuedCommand(userText(message)))) {
      return runPromptMessages.call(this, messages, options);
    }

    let cancelled = false;
    await this.runWithLifecycle(async signal => {
      await consumeQueuedCommands(session, messages, output);
      cancelled = signal.aborted;
    });

    if (!cancelled && !session[reachedCompaction] && this.hasQueuedMessages()) return this.continue();
  });
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const { root } = supportedPi(executable);
  const { installRuntimeStorage } = await import("./sdk-storage.mjs");
  const { installStorage } = await import("./piop-storage/bootstrap.mjs");
  await installRuntimeStorage(root);
  await installStorage(root);
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];

  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  requireMethods(AgentSession.prototype, [
    "_queueFollowUp", "_emitQueueUpdate", "_findLastAssistantMessage", "_findPersistedMessageEntryId", "_omitRecoveryAttempt", "_recordSelection",
    "_resolveIdleWaitIfIdle", "_preparePromptAndToolLoadout", "_refreshFinalizedContext", "_handlePostAgentRun", "_runBeforeSettleBoundary",
    "_finishCancelledRetry", "_flushPendingBashMessages", "_flushPendingCustomMessages", "_emitAgentSettled",
  ]);
  const { McpServerConnection } = await import(pathToFileURL(join(root, "dist/extensions/mcp/runtime.js")).href);
  require("./mcp-connections.cjs").installConnectionEvents(McpServerConnection);
  require("./runtime-availability.cjs").installAvailability(AgentSession);

  queueValidation = await queueContracts(root);
  installReloadLifecycle(AgentSession);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  patchMethod(AgentSession.prototype, "prompt", prompt => async function (text, options) {
    const disabled = disabledCommands.get(commandName(text));

    if (disabled !== undefined) throw new Error(disabled);

    if (this[runningCompaction]) await this[runningCompaction];

    if (imageCommands.has(commandName(text))) {
      await executePluginCommand(this, text, options?.images ?? []);
      options?.preflightResult?.("handled");

      return;
    }

    if (queuedCommand(text) && this.isStreaming) {
      return this._queueFollowUp(text, options?.images).then(() => options?.preflightResult?.("queued"));
    }

    return prompt.call(this, text, options);
  });

  let session;
  let markSessionReady;
  const sessionReady = new Promise(resolve => { markSessionReady = resolve; });
  patchMethod(AgentSession.prototype, "bindExtensions", bind => async function (...bindings) {
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
  });

  appInput(command => dispatch(command, () => session, sessionReady, output), runtimeEvents(output));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

module.exports = { continueRun, dispatchPrompt, installQueueProtocol };
