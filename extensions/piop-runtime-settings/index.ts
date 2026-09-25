import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadAccountProviders } from "./provider-accounts.mjs";

type Settings = {
  tools: string[];
  skills: string[];
  explicitOnlySkills?: string[];
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
};
type Update = { ctx: ExtensionContext; ready?: Promise<void> };
const key = Symbol.for("piop.runtime-settings");
const replyKey = Symbol.for("piop.runtime-settings.reply");
const bootKey = Symbol.for("piop.runtime-settings.boot");
const processState = globalThis as typeof globalThis & { [key]?: Settings; [replyKey]?: (value: string) => void; [bootKey]?: boolean };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function skillsChanged(previous: Settings, next: Settings) {
  return JSON.stringify(previous.skills) !== JSON.stringify(next.skills) || JSON.stringify(previous.explicitOnlySkills) !== JSON.stringify(next.explicitOnlySkills);
}

function validate(value: Settings): Settings {
  if (value?.explicitOnlySkills !== undefined && !isStringList(value.explicitOnlySkills)) throw new Error("Invalid explicit skill policy");
  if (!value || !isStringList(value.tools) || !isStringList(value.skills) || !Number.isSafeInteger(value.contextWindowCap) || value.contextWindowCap < 1000 || typeof value.contextWindowCapEnabled !== "boolean") throw new Error("Invalid runtime settings");
  return structuredClone(value);
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  const accountProviders = new Map();
  const refreshAccounts = async () => {
    const existing = new Map(accountProviders);
    await loadAccountProviders(join(getAgentDir(), "auth.json"), () => ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }), accountProviders);
    for (const [id, provider] of accountProviders) if (existing.get(id) !== provider) pi.registerProvider(provider);
  };
  await refreshAccounts();
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
  pi.on("before_agent_start", (event) => {
    if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1" || !current().explicitOnlySkills?.length) return;
    const normalize = (value: string) => resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
    const explicit = new Set(current().explicitOnlySkills?.map(normalize));
    const options = event.systemPromptOptions;
    const readTool = (["read", "bash"] as const).find((tool) => (options.selectedTools ?? ["read", "bash"]).includes(tool));
    if (!readTool || !options.skills?.length) return;
    const original = formatSkillsForPrompt(options.skills, readTool);
    const filtered = formatSkillsForPrompt(options.skills.map((skill) => explicit.has(normalize(skill.filePath)) || explicit.has(normalize(skill.baseDir)) ? { ...skill, disableModelInvocation: true } : skill), readTool);
    if (original && original !== filtered) return { systemPrompt: event.systemPrompt.replace(original, filtered) };
  });
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
        if (request.reloadAgents || skillsChanged(previous, next)) {
          await ctx.reload();
        } else {
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
        await refreshAccounts();
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        pi.events.emit("piop:models-refreshed", { ctx });
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "provider_auth_refresh", success: true })}`);
      } catch {
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id: request.id, command: "provider_auth_refresh", success: false, error: "Could not refresh provider models. Reopen the conversation to retry." })}`);
      }
    },
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
