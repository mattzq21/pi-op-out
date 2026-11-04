import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installRuntimeStorage } from "../../daemon/resources/sdk-storage.mjs";
import { patchMethod } from "../../daemon/resources/pi-patch.cjs";
import { agentExtensions } from "./extension-loader.ts";
import type { ExtensionAPI, ExtensionRuntime, ModelRegistry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import commandNames from "../../daemon/resources/agent-commands.json";
import { bindValidationSession } from "./validation-session.ts";
import type { Agent } from "./contracts.ts";

export function piDirectory() {
  const root = process.env.PIOP_PI_ROOT;

  if (!root) throw new Error("The daemon did not give the Pi installation folder");

  return root;
}

export async function extensionValidator(registeredToolNames: string[]) {
  const directory = piDirectory();
  await installRuntimeStorage(directory);
  const loaderUrl = pathToFileURL(join(directory, "dist/core/extensions/jiti-static-loader.js")).href;
  const { createJiti } = await import(loaderUrl);
  const { VIRTUAL_MODULES } = await import(pathToFileURL(join(directory, "dist/core/extensions/virtual-modules.js")).href);
  const loader = createJiti(loaderUrl, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES });
  const { createExtensionRuntime, loadExtensionFromFactory } = await import(pathToFileURL(join(directory, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(directory, "dist/core/event-bus.js")).href);
  const { ExtensionRunner } = await import(pathToFileURL(join(directory, "dist/core/extensions/runner.js")).href);
  const { SessionManager } = await import(pathToFileURL(join(directory, "dist/core/session-manager.js")).href);
  const { SettingsManager } = await import(pathToFileURL(join(directory, "dist/core/settings-manager.js")).href);

  return async (paths: string[], base: string, registry: ModelRegistry, agent: Agent, validate: () => Promise<void>) => {
    const runtime: ExtensionRuntime = createExtensionRuntime();
    const events = createEventBus();
    patchMethod(runtime, "getAllTools", () => () => registeredToolNames.map((name): ToolInfo => ({ name, description: "", parameters: Type.Object({}), exposure: "direct", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } })), "ExtensionRuntime");
    patchMethod(runtime, "getCommands", () => () => commandNames.map(name => ({ name, source: "extension", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } })), "ExtensionRuntime");
    const session = SessionManager.inMemory(base);
    const runner = new ExtensionRunner([], runtime, base, session, registry);
    bindValidationSession(runtime, runner, session, registry, agent, SettingsManager.create(base).getSettings());
    let tools: string[] = [];
    let activate = async () => {};

    let deactivate = async () => {};

    try {
      await loadExtensionFromFactory(async (pi: ExtensionAPI) => {
        const extensions = agentExtensions(pi, base, entry => loader.import(entry));
        const group = await extensions.prepare(paths, runner.createContext());
        activate = () => extensions.activate(group, runner.createContext());
        deactivate = () => extensions.deactivate(runner.createContext(), { type: "session_shutdown", reason: "reload" });
        tools = extensions.tools(group);
      }, base, events, runtime);
      await activate();
      await validate();
    } finally {
      try { await deactivate(); }
      finally { events.clear(); runtime.invalidate(); }
    }

    return tools;
  };
}
