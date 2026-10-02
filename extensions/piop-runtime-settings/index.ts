import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
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

const stringListSchema = Type.Array(Type.String());

const settingsSchema = Type.Object({
  tools: stringListSchema, skills: stringListSchema, explicitOnlySkills: Type.Optional(stringListSchema),
  contextWindowCap: Type.Integer({ minimum: 1000, maximum: Number.MAX_SAFE_INTEGER }), contextWindowCapEnabled: Type.Boolean(),
});

const requestSchema = Type.Object({ id: Type.String(), settings: Type.Optional(Type.Unknown()), reloadAgents: Type.Optional(Type.Boolean()) });

const idSchema = Type.Object({ id: Type.String() });

const settingsPatchSchema = Type.Record(Type.String(), Type.Unknown());

const setGlobal = <T>(property: symbol, value: T) => Object.defineProperty(globalThis, property, { value, writable: true, configurable: true, enumerable: true });

function storedSettings() {
  const value = Object.getOwnPropertyDescriptor(globalThis, key)?.value;

  return Check(settingsSchema, value) ? value : undefined;
}

function reply(value: string) {
  const handler = Object.getOwnPropertyDescriptor(globalThis, replyKey)?.value;

  if (handler instanceof Function) handler(value);
}

type RuntimeSettingsRequest = { settings?: Settings };

type RequiredToolsRequest = { ctx: ExtensionContext; tools: string[] };

const readingTools: Array<"read" | "bash"> = ["read", "bash"];

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:runtime-settings", handler: (request: RuntimeSettingsRequest) => void): () => void;
    emit(channel: "piop:runtime-settings", request: RuntimeSettingsRequest): void;
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

function skillsChanged(previous: Settings, next: Settings) {
  return JSON.stringify(previous.skills) !== JSON.stringify(next.skills) || JSON.stringify(previous.explicitOnlySkills) !== JSON.stringify(next.explicitOnlySkills);
}

function validate(value: Settings): Settings {
  if (value?.explicitOnlySkills !== undefined && !Check(stringListSchema, value.explicitOnlySkills)) throw new Error("Invalid explicit skill policy");

  if (!Check(settingsSchema, value)) throw new Error("Invalid runtime settings");

  return structuredClone(value);
}

function capabilitySummary(description: string) {
  const summary = description.trim().split(/\n\s*\n/, 1)[0].replace(/\s+/g, " ");

  return summary.length > 360 ? `${summary.slice(0, 357).trimEnd()}...` : summary;
}

function codemodeAppendix(pi: ExtensionAPI) {
  const active = new Set(pi.getActiveTools());

  if (!active.has("codemode")) return "";
  const groups = new Map<string, { description?: string; tools: string[] }>();

  for (const tool of pi.getAllTools()) {
    const exposure = tool.exposure ?? "direct";

    if (tool.name === "codemode" || !(exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name)))) continue;
    const namespace = tool.namespace?.name ?? "Session tools";
    let group = groups.get(namespace);

    if (!group) {
      group = { description: tool.namespace?.description, tools: [] };
      groups.set(namespace, group);
    }

    group.tools.push(`- ${JSON.stringify(tool.name)}: ${capabilitySummary(tool.description) || "No summary supplied; inspect this tool with describeTool before use."}`);
  }

  return [
    "## Codemode capability appendix",
    "Use this inventory to recognize what you can already do through codemode. Before building a workaround or reaching for shell commands or a separate integration, check for a tool that handles the task. These are brief summaries supplied by the tools, not complete usage instructions or permission to act.",
    "Inside codemode, use searchTools(query) to discover relevant tools, describeTool(name) to inspect the full description and argument schema, and describeNamespace(name) for MCP/server guidance. Use the returned callable identifier with await tools.<identifier>(args); do not guess arguments from these summaries. Await calls, pass results between tools, and return only useful output with text(...) or image(...). Independent calls can run together; sequence calls that depend on earlier results. Codemode itself has no direct filesystem or network access; use the available tools for those capabilities.",
    ...[...groups].map(([name, group]) => `### ${JSON.stringify(name)}${group.description ? ` — ${capabilitySummary(group.description)}` : ""}\n${group.tools.join("\n")}`),
  ].join("\n\n");
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  const accountProviders = new Map();

  const refreshAccounts = async () => {
    const existing = new Map(accountProviders);
    await loadAccountProviders(join(getAgentDir(), "auth.json"), () => ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }), accountProviders);

    for (const [id, provider] of accountProviders) if (existing.get(id) !== provider) pi.registerProvider(provider);
  };

  await refreshAccounts();

  if (!storedSettings()) setGlobal(key, validate(JSON.parse(await readFile(process.env.PIOP_RUNTIME_SETTINGS_PATH || join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "runtime-settings.json"), "utf8"))));

  const current = () => { const value = storedSettings();

  if (!value) throw new Error("Runtime settings are unavailable");

  return value; };

  const unsubscribe = pi.events.on("piop:runtime-settings", (value) => { value.settings = structuredClone(current()); });
  pi.registerFlag("piop-runtime-settings", { description: "Inherited Piop runtime settings", type: "string" });

  const applyTools = (ctx: ExtensionContext) => {
    const required: RequiredToolsRequest = { ctx, tools: [] }; pi.events.emit("piop:required-tools", required);

    if (process.env.PI_DEFINE_AGENTS_ACTIVE !== "1") pi.setActiveTools([...new Set([...current().tools, ...required.tools])].filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
  };

  pi.on("session_start", (_event, ctx) => {
    setGlobal(replyKey, (value: string) => ctx.ui.setStatus("pi-desktop-control-response", value));

    if (Object.getOwnPropertyDescriptor(globalThis, bootKey)?.value !== true) {
      const inherited = pi.getFlag("piop-runtime-settings");

      if (Check(Type.String(), inherited)) setGlobal(key, validate(JSON.parse(inherited)));
      setGlobal(bootKey, true);
    }

    applyTools(ctx);
  });
  pi.on("resources_discover", () => process.env.PI_DEFINE_AGENTS_ACTIVE === "1" ? undefined : { skillPaths: current().skills });
  pi.on("before_agent_start", (event) => {
    const appendix = codemodeAppendix(pi);

    if (!appendix) return;
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = [options.appendSystemPrompt, appendix].filter(Boolean).join("\n\n");

    if (options.forceSystemPrompt !== undefined) options.forceSystemPrompt += `\n\n${appendix}`;
  });
  pi.on("before_agent_start", (event) => {
    if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1" || !current().explicitOnlySkills?.length) return;
    const normalize = (value: string) => resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
    const explicit = new Set(current().explicitOnlySkills?.map(normalize));
    const options = event.systemPromptOptions;
    const readTool = readingTools.find((tool) => (options.selectedTools ?? ["read", "bash"]).includes(tool));

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
      const request = Parse(requestSchema, JSON.parse(args));
      const previous = current();

      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const patch = request.settings ?? {};

        if (!Check(settingsPatchSchema, patch)) throw new Error("Invalid runtime settings");
        const next = validate({ ...previous, ...patch });
        setGlobal(key, next);

        if (request.reloadAgents || skillsChanged(previous, next)) {
          await ctx.reload();
        } else {
          applyTools(ctx);

          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }

        reply(`json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: true })}`);
      } catch (error) {
        setGlobal(key, previous);
        reply(`json:${JSON.stringify({ type: "response", id: request.id, command: "runtime_settings", success: false, error: error instanceof Error ? error.message : String(error) })}`);
      }
    },
  });
  pi.registerCommand("piop-provider-auth-refresh", {
    description: "Refresh models after a host provider login changes",
    handler: async (args, ctx) => {
      const request = Parse(idSchema, JSON.parse(args));

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
