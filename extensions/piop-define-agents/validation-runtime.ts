import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { agentExtensions } from "./extension-loader.ts";
import type { ExtensionAPI, ExtensionRuntime, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function piEntry() {
  const executable = process.env.PIOP_PI_EXECUTABLE || "pi";
  const expanded = executable.startsWith("~/") ? join(homedir(), executable.slice(2)) : executable;
  const candidates = /[/\\]/.test(expanded) ? [resolve(expanded)] : (process.env.PATH || "").split(delimiter).map(directory => join(directory, expanded));

  for (const path of candidates) {
    try { return await realpath(path); } catch { }
  }

  throw new Error("Pi is unavailable for extension validation");
}

async function piDirectory() {
  let directory = dirname(await piEntry());

  while (directory !== dirname(directory)) {
    let metadata;

    try { metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); } catch { }

    if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(metadata?.name)) return directory;
    directory = dirname(directory);
  }

  throw new Error("Extension validation requires a Pi Node installation");
}

export async function extensionValidator(toolNames: string[]) {
  const directory = await piDirectory();
  const loaderUrl = pathToFileURL(join(directory, "dist/core/extensions/jiti-static-loader.js")).href;
  const { createJiti } = await import(loaderUrl);
  const { VIRTUAL_MODULES } = await import(pathToFileURL(join(directory, "dist/core/extensions/virtual-modules.js")).href);
  const loader = createJiti(loaderUrl, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES });
  const { createExtensionRuntime, loadExtensionFromFactory } = await import(pathToFileURL(join(directory, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(directory, "dist/core/event-bus.js")).href);

  return async (paths: string[], base: string) => {
    const runtime: ExtensionRuntime = createExtensionRuntime();
    const events = createEventBus();
    runtime.getAllTools = () => toolNames.map((name): ToolInfo => ({ name, description: "", parameters: Type.Object({}), exposure: "direct", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } }));
    runtime.getCommands = () => [];

    try {
      await loadExtensionFromFactory(async (pi: ExtensionAPI) => {
        const extensions = agentExtensions(pi, base, entry => loader.import(entry));
        await extensions.prepare(paths);
      }, base, events, runtime);
    } finally { events.clear(); }
  };
}
