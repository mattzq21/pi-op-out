import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { agentExtensions } from "./extension-loader.ts";
import type { ExtensionAPI, ExtensionRuntime, ModelRegistry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import commandNames from "../../src-tauri/resources/agent-commands.json";

async function piEntry() {
  const executable = process.env.PIOP_PI_EXECUTABLE || "pi";
  const expanded = executable.startsWith("~/") ? join(homedir(), executable.slice(2)) : executable;
  const candidates = /[/\\]/.test(expanded) ? [resolve(expanded)] : (process.env.PATH || "").split(delimiter).map(directory => join(directory, expanded));

  for (const path of candidates) {
    try { return await realpath(path); } catch { }
  }

  throw new Error("Pi is unavailable for extension validation");
}

export async function piDirectory() {
  let directory = dirname(await piEntry());

  while (directory !== dirname(directory)) {
    let metadata;

    try { metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); } catch { }

    if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(metadata?.name)) return directory;
    directory = dirname(directory);
  }

  throw new Error("Extension validation requires a Pi Node installation");
}

export async function extensionValidator(registeredToolNames: string[]) {
  const directory = await piDirectory();
  const loaderUrl = pathToFileURL(join(directory, "dist/core/extensions/jiti-static-loader.js")).href;
  const { createJiti } = await import(loaderUrl);
  const { VIRTUAL_MODULES } = await import(pathToFileURL(join(directory, "dist/core/extensions/virtual-modules.js")).href);
  const loader = createJiti(loaderUrl, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES });
  const { createExtensionRuntime, loadExtensionFromFactory } = await import(pathToFileURL(join(directory, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(directory, "dist/core/event-bus.js")).href);
  const { ExtensionRunner } = await import(pathToFileURL(join(directory, "dist/core/extensions/runner.js")).href);
  const { SessionManager } = await import(pathToFileURL(join(directory, "dist/core/session-manager.js")).href);

  return async (paths: string[], base: string, registry: ModelRegistry) => {
    const runtime: ExtensionRuntime = createExtensionRuntime();
    const events = createEventBus();
    runtime.getAllTools = () => registeredToolNames.map((name): ToolInfo => ({ name, description: "", parameters: Type.Object({}), exposure: "direct", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } }));
    runtime.getCommands = () => commandNames.map(name => ({ name, source: "extension", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } }));
    runtime.registerProvider = (name, config) => registry.registerProvider(name, config);
    runtime.registerNativeProvider = provider => registry.registerProvider(provider);
    runtime.unregisterProvider = name => registry.unregisterProvider(name);
    runtime.registerVirtualModel = definition => registry.registerVirtualModel(definition);
    runtime.unregisterVirtualModel = (provider, id) => registry.unregisterVirtualModel(provider, id);
    const runner = new ExtensionRunner([], runtime, base, SessionManager.inMemory(base), registry);
    runtime.createContext = () => runner.createContext();
    let tools: string[] = [];
    let activate = async () => {};

    let stop = () => {};

    try {
      await loadExtensionFromFactory(async (pi: ExtensionAPI) => {
        const extensions = agentExtensions(pi, base, entry => loader.import(entry));
        const group = await extensions.prepare(paths);
        activate = () => extensions.activate(group, runner.createContext());
        stop = extensions.stop;
        tools = extensions.tools(group);
      }, base, events, runtime);
      await activate();
    } finally { stop(); events.clear(); runtime.invalidate(); }

    return tools;
  };
}
