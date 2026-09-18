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
const replyKey = Symbol.for("piop.runtime-settings.reply");
const bootKey = Symbol.for("piop.runtime-settings.boot");
const processState = globalThis as typeof globalThis & { [key]?: Settings; [replyKey]?: (value: string) => void; [bootKey]?: boolean };

function validate(value: Settings): Settings {
  if (!value || !Array.isArray(value.tools) || !value.tools.every((item) => typeof item === "string") || !Array.isArray(value.skills) || !value.skills.every((item) => typeof item === "string") || !Array.isArray(value.mcpServers) || !Number.isSafeInteger(value.contextWindowCap) || value.contextWindowCap < 1000 || typeof value.contextWindowCapEnabled !== "boolean") throw new Error("Invalid runtime settings");
  return structuredClone(value);
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  processState[key] ??= validate(JSON.parse(await readFile(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "runtime-settings.json"), "utf8")));
  const current = () => processState[key]!;
  const unsubscribe = pi.events.on("piop:runtime-settings", (value) => { (value as { settings?: Settings }).settings = structuredClone(current()); });
  pi.registerFlag("piop-runtime-settings", { description: "Inherited Piop runtime settings", type: "string" });
  const applyTools = () => {
    if (process.env.PI_DEFINE_AGENTS_ACTIVE !== "1") pi.setActiveTools(current().tools.filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
  };
  pi.on("session_start", (_event, ctx) => {
    processState[replyKey] = (value) => ctx.ui.setStatus("pi-desktop-control-response", value);
    if (!processState[bootKey]) {
      const inherited = pi.getFlag("piop-runtime-settings");
      if (typeof inherited === "string") processState[key] = validate(JSON.parse(inherited));
      processState[bootKey] = true;
    }
    applyTools();
  });
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
      const request = JSON.parse(args) as { id: string; settings: Settings; reloadAgents?: boolean };
      const previous = current();
      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const next = validate({ ...previous, ...request.settings });
        processState[key] = next;
        if (request.reloadAgents || JSON.stringify(previous.skills) !== JSON.stringify(next.skills)) {
          // Pi exposes skill registry updates through resource reload, without restarting the process.
          await ctx.reload();
        } else {
          await update("piop:mcp:update", ctx);
          applyTools();
          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }
        processState[replyKey]?.(`json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: true })}`);
      } catch (error) {
        processState[key] = previous;
        processState[replyKey]?.(`json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: false, error: error instanceof Error ? error.message : String(error) })}`);
      }
    },
  });
  pi.registerCommand("piop-provider-auth-refresh", {
    description: "Refresh models after a host provider login changes",
    handler: async (args, ctx) => {
      const request = JSON.parse(args) as { id: string };
      if (ctx.mode !== "rpc") return;
      try {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "provider_auth_refresh", success: true })}`);
      } catch {
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "provider_auth_refresh", success: false, error: "Could not refresh provider models. Reopen the conversation to retry." })}`);
      }
    },
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
