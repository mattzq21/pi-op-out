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

async function dispatch(command, session) {
  const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);

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

async function main() {
  const [executable, ...args] = process.argv.slice(2);
  const root = runtimeRoot(executable);
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  let session;
  const bind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function (...bindings) {
    await bind.apply(this, bindings);
    session = this;
  };

  appInput(command => dispatch(command, session));
  process.argv = [process.execPath, join(root, "dist/cli.js"), ...args];
  await import(pathToFileURL(join(root, "dist/cli.js")).href);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
