import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
    emit(channel: "piop:rpc", request: AppRequest): void;
  }
}

const key = Symbol.for("piop.runtime-settings");

const bootKey = Symbol.for("piop.runtime-settings.boot");

const stringListSchema = Type.Array(Type.String());

const settingsSchema = Type.Object({
  tools: stringListSchema, skills: stringListSchema, explicitOnlySkills: Type.Optional(stringListSchema),
  contextWindowCap: Type.Integer({ minimum: 1000, maximum: Number.MAX_SAFE_INTEGER }), contextWindowCapEnabled: Type.Boolean(),
});

const requestSchema = Type.Object({ settings: Type.Optional(Type.Unknown()), reloadAgents: Type.Optional(Type.Boolean()) });

const settingsPatchSchema = Type.Record(Type.String(), Type.Unknown());

const setGlobal = <T>(property: symbol, value: T) => Object.defineProperty(globalThis, property, { value, writable: true, configurable: true, enumerable: true });

function storedSettings() {
  const value = Object.getOwnPropertyDescriptor(globalThis, key)?.value;

  return Check(settingsSchema, value) ? value : undefined;
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
  const summary = description.trim().split(/\n|[.!?](?:\s|$)/, 1)[0].replace(/\s+/g, " ");

  return summary.length > 120 ? `${summary.slice(0, 117).replace(/\s+\S*$/, "")}...` : summary;
}

const abilitiesEntry = "piop-codemode-abilities";
const abilitiesSchema = Type.Object({
  tools: Type.Array(Type.String()),
  batches: Type.Array(Type.Object({ text: Type.String(), timestamp: Type.Number() })),
});

function codemodeAbilities(pi: ExtensionAPI, ctx: ExtensionContext) {
  const active = new Set(pi.getActiveTools());

  if (!active.has("codemode")) return;
  const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === abilitiesEntry);
  const saved = entry?.type === "custom" && Check(abilitiesSchema, entry.data) ? entry.data : { tools: [], batches: [] };
  const state = structuredClone(saved);
  const known = new Set(state.tools);
  const phrases = new Set<string>();

  for (const tool of pi.getAllTools()) {
    const exposure = tool.exposure ?? "direct";

    if (tool.name === "codemode" || known.has(tool.name) || !(exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name)))) continue;
    state.tools.push(tool.name);
    phrases.add(capabilitySummary(tool.description) || tool.name.replace(/_/g, " "));
  }

  if (phrases.size || !state.batches.length) {
    const prefix = state.batches.length ? "Codemode's tools abilities also include: " : "Codemode's tools abilities include: ";
    state.batches.push({ text: prefix + ([...phrases].join("; ") || "no tools currently available"), timestamp: Date.now() });
    pi.appendEntry(abilitiesEntry, state);
  }

  return state.batches;
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  setGlobal(Symbol.for("piop.app-rpc"), (request: AppRequest) => pi.events.emit("piop:rpc", request));
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
    if (Object.getOwnPropertyDescriptor(globalThis, bootKey)?.value !== true) {
      const inherited = pi.getFlag("piop-runtime-settings");

      if (Check(Type.String(), inherited)) setGlobal(key, validate(JSON.parse(inherited)));
      setGlobal(bootKey, true);
    }

    applyTools(ctx);
  });
  pi.on("resources_discover", () => process.env.PI_DEFINE_AGENTS_ACTIVE === "1" ? undefined : { skillPaths: current().skills });
  pi.on("before_agent_start", (event, ctx) => {
    const batches = codemodeAbilities(pi, ctx);

    if (!batches) return;
    const options = event.systemPromptOptions;
    const instructions = options.sections?.codemode ?? pi.getAllTools().find((tool) => tool.name === "codemode")?.promptGuidelines?.join("\n");
    options.sections = { ...options.sections, codemode: [instructions, batches[0].text].filter(Boolean).join("\n\n") };
    options.toolGuidelines = { ...options.toolGuidelines, codemode: [] };

    for (let index = 1; index < batches.length; index++) options.sections[`codemode_abilities_${index}`] = batches[index].text;

    if (options.forceSystemPrompt !== undefined) options.forceSystemPrompt += `\n\n${Object.entries(options.sections).filter(([name]) => name === "codemode" || name.startsWith("codemode_abilities_")).map(([, value]) => value).join("\n\n")}`;
  });
  pi.on("context", (event, ctx) => {
    const batches = codemodeAbilities(pi, ctx);

    if (!batches) return;
    const sections = Object.assign({}, ...event.messages.filter((message) => message.role === "system").map((message) => message.sections));
    const messages = [...event.messages];

    for (let index = 1; index < batches.length; index++) {
      const name = `codemode_abilities_${index}`;

      if (sections[name]) continue;
      const batch = batches[index];
      const position = messages.findIndex((message) => message.timestamp > batch.timestamp);
      messages.splice(position < 0 ? messages.length : position, 0, { role: "system", content: "", sections: { [name]: `<${name}>\n${batch.text}\n</${name}>` }, timestamp: batch.timestamp });
    }

    return { messages };
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

  pi.events.on("piop:rpc", request => {
    if (request.command !== "runtime_settings") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const settingsRequest = Parse(requestSchema, request.payload);
      const previous = current();

      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const patch = settingsRequest.settings ?? {};

        if (!Check(settingsPatchSchema, patch)) throw new Error("Invalid runtime settings");
        const next = validate({ ...previous, ...patch });
        setGlobal(key, next);

        if (settingsRequest.reloadAgents || skillsChanged(previous, next)) {
          await ctx.reload();
        } else {
          applyTools(ctx);

          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }
      } catch (error) {
        setGlobal(key, previous);
        throw error;
      }
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "provider_auth_refresh") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      try {
        await refreshAccounts();
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        pi.events.emit("piop:models-refreshed", { ctx });
      } catch {
        throw new Error("Could not refresh provider models. Reopen the conversation to retry.");
      }
    })();
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
