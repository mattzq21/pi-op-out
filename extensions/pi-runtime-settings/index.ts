import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Settings = {
  tools: string[];
  skills: string[];
  mcpServers: unknown[];
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
};
type Update = { ctx: ExtensionContext; ready?: Promise<void> };
const key = Symbol.for("piop.runtime-settings");
const processState = globalThis as typeof globalThis & { [key]?: Settings };

function validate(value: Settings): Settings {
  if (!value || !Array.isArray(value.tools) || !value.tools.every((item) => typeof item === "string") || !Array.isArray(value.skills) || !value.skills.every((item) => typeof item === "string") || !Array.isArray(value.mcpServers) || !Number.isSafeInteger(value.contextWindowCap) || value.contextWindowCap < 1000 || typeof value.contextWindowCapEnabled !== "boolean") throw new Error("Invalid runtime settings");
  return structuredClone(value);
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  processState[key] ??= validate(JSON.parse(await readFile(join(homedir(), ".piop", "runtime-settings.json"), "utf8")));
  const current = () => processState[key]!;
  const unsubscribe = pi.events.on("piop:runtime-settings", (request: { settings?: Settings }) => { request.settings = structuredClone(current()); });
  const applyTools = () => {
    if (process.env.PI_DEFINE_AGENTS_ACTIVE !== "1") pi.setActiveTools(current().tools.filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
  };
  pi.on("session_start", applyTools);
  pi.on("resources_discover", () => process.env.PI_DEFINE_AGENTS_ACTIVE === "1" ? undefined : { skillPaths: current().skills });
  const update = async (event: string, ctx: ExtensionContext) => {
    const request: Update = { ctx };
    pi.events.emit(event, request);
    if (!request.ready) throw new Error(`Live settings handler unavailable: ${event}`);
    await request.ready;
  };
  pi.registerCommand("piop-runtime-settings", {
    description: "Apply saved Piop runtime settings",
    handler: async (args, ctx) => {
      const request = JSON.parse(args) as { id: string; settings: Settings };
      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const previous = current();
        const next = validate(request.settings);
        processState[key] = next;
        if (JSON.stringify(previous.skills) !== JSON.stringify(next.skills)) {
          // Pi exposes skill registry updates through resource reload, without restarting the process.
          await ctx.reload();
        } else {
          if (JSON.stringify(previous.mcpServers) !== JSON.stringify(next.mcpServers)) await update("piop:mcp:update", ctx);
          await update("piop:context-cap:update", ctx);
          applyTools();
          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: true })}`);
      } catch (error) {
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: false, error: error instanceof Error ? error.message : String(error) })}`);
      }
    },
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
