const { realpathSync, readFileSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");

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
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge"))?.value;

    if (!session || !emit) throw new Error("Piop app requests are unavailable");
    const request = { command: command.command, payload: command.payload, ctx: session.extensionRunner.createCommandContext() };
    emit(request);

    if (!request.ready) throw new Error(`Unknown app request: ${command.command}`);
    const data = await request.ready;
    output({ type: "response", id: command.id, command: command.command, success: true, data });
  } catch (error) {
    output({ type: "response", id: command.id, command: command.command, success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const isReview = text => /^\/review(?:\s|$)/.test(text);

async function executeQueuedReview(session, text, images) {
  const ctx = session.extensionRunner.createCommandContext();
  const request = { command: "start_review", payload: { args: text.slice(7).trim(), images }, ctx };

  try {
    Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-bridge")).value(request);
    if (!request.ready) throw new Error("Review requests are unavailable");
    await request.ready;
  } catch (error) {
    ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function consumeReviews(session, messages) {
  const prompts = [];

  for (const message of messages) {
    const text = message.role === "user" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

    if (!isReview(text)) { prompts.push(message); continue; }
    const pending = session.getFollowUpMessages();
    const index = pending.indexOf(text);

    if (index !== -1) pending.splice(index, 1);
    session._emitQueueUpdate();
    await executeQueuedReview(session, text, message.content.filter(part => part.type === "image"));
  }

  return prompts;
}

async function drainReviews(session, drain) {
  while (true) {
    const messages = await drain();

    if (!messages.length) return messages;
    const prompts = await consumeReviews(session, messages);

    if (prompts.length) return prompts;
  }
}

function bindReviewQueue(session) {
  const agent = session.agent;
  const createLoopConfig = agent.createLoopConfig;
  const runPromptMessages = agent.runPromptMessages;

  agent.createLoopConfig = function (...args) {
    const config = createLoopConfig.apply(this, args);
    const followUp = config.getFollowUpMessages;
    config.getFollowUpMessages = () => drainReviews(session, followUp);

    return config;
  };
  agent.runPromptMessages = async function (messages, options) {
    if (options?.skipInitialSteeringPoll) return runPromptMessages.call(this, messages, options);
    const prompts = await consumeReviews(session, messages);

    if (prompts.length) return runPromptMessages.call(this, prompts, options);
    if (this.hasQueuedMessages()) return this.continue();
  };
}

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  const prompt = AgentSession.prototype.prompt;

  AgentSession.prototype.prompt = function (text, options) {
    if (isReview(text) && this.isStreaming) {
      const queued = this._queueFollowUp(text, options?.images);

      return queued.then(() => options?.preflightResult?.("queued"));
    }
    const value = text.match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();
    const objective = value && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

    return prompt.call(this, text, objective ? { ...options, expandPromptTemplates: false } : options);
  };

  let session;
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    await bind.apply(this, bindings);
    if (session !== this) bindReviewQueue(this);
    session = this;
  };

  appInput(command => dispatch(command, session, output));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
