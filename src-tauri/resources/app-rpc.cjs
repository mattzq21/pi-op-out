const { realpathSync, readFileSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");

const queuedInput = new AsyncLocalStorage();

const taggedAgents = new WeakSet();

function tagQueuedInput(input) {
  const delivery = queuedInput.getStore();

  if (!delivery || delivery.tagged) return;
  const message = (Array.isArray(input) ? input : [input]).find(value => value?.role === "user");

  if (!message) return;
  message.piopQueueInputId = delivery.id;
  delivery.tagged = true;
}

function bindQueuedInputs(agent) {
  if (taggedAgents.has(agent)) return;
  taggedAgents.add(agent);

  for (const name of ["prompt", "steer", "followUp"]) {
    const original = agent[name];
    agent[name] = function (input, ...args) {
      tagQueuedInput(input);

      return original.call(this, input, ...args);
    };
  }
}

function isQueuedPrompt(command) {
  return command?.type === "prompt" && Object.hasOwn(command, "queueInputId");
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

      if (command?.type === "piop_request" || isQueuedPrompt(command)) void dispatch(command);
      else input.write(`${line}\n`);
    }
  });
  stdin.on("end", () => { if (pending) input.write(pending); input.end(); });
}

async function dispatch(command, session, output) {
  if (isQueuedPrompt(command)) return dispatchQueuedPrompt(command, session, output);

  try {
    const emit = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.app-rpc"))?.value;

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

async function dispatchQueuedPrompt(command, session, output) {
  let accepted = false;

  const accept = disposition => {
    if (accepted) return;
    accepted = true;
    output({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition } });
  };

  try {
    if (!session) throw new Error("Piop app requests are unavailable");
    const queueInputId = String(command.queueInputId);

    if (command.queueInputId !== queueInputId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queueInputId)) throw new Error("Invalid queued input identity");
    await session.prompt(command.message, { images: command.images, streamingBehavior: command.streamingBehavior,
      source: "rpc", piopQueueInputId: queueInputId, preflightResult: accept });
    accept("completed");
  } catch (error) {
    if (!accepted) output({ type: "response", id: command.id, command: "prompt", success: false, error: error instanceof Error ? error.message : String(error) });
  }
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
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { writeRawStdout } = await import(pathToFileURL(join(root, "dist/core/output-guard.js")).href);
  const output = value => writeRawStdout(`${JSON.stringify(value)}\n`);
  const prompt = AgentSession.prototype.prompt;

  AgentSession.prototype.prompt = function (text, options) {
    const value = text.match(/^\/goal\s+([\s\S]*)$/)?.[1].trim();
    const objective = value && !["edit", "clear", "pause", "resume", "budget"].includes(value) && !value.startsWith("budget ");

    const delivery = options?.piopQueueInputId ? { id: options.piopQueueInputId, tagged: false } : undefined;

    return queuedInput.run(delivery, () => prompt.call(this, text, objective ? { ...options, expandPromptTemplates: false } : options));
  };

  let session;
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    await bind.apply(this, bindings);
    bindQueuedInputs(this.agent);
    session = this;
  };

  appInput(command => dispatch(command, session, output));
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
