import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { readFile as readSettings } from "./app-settings.cjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

type Settings = {
  tools: string[];
  skills: string[];
  explicitOnlySkills?: string[];
};

type Update = { ctx: ExtensionCommandContext; ready?: Promise<void> };

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

export default async function runtimeSettings(pi: ExtensionAPI) {
  setGlobal(Symbol.for("piop.runtime-bridge"), (request: AppRequest) => pi.events.emit("piop:rpc", request));

  if (!storedSettings()) setGlobal(key, validate(readSettings(process.env.PIOP_RUNTIME_SETTINGS_PATH || join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "runtime-settings.json"))));

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

  const update = async (event: string, ctx: ExtensionCommandContext) => {
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
      let applied = false;

      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const patch = settingsRequest.settings ?? {};

        if (!Check(settingsPatchSchema, patch)) throw new Error("Invalid runtime settings");
        const next = validate({ ...previous, ...patch });
        setGlobal(key, next);

        if (settingsRequest.reloadAgents || skillsChanged(previous, next)) {
          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:reload", ctx);
          else await ctx.reload();
        } else {
          applied = true;
          applyTools(ctx);

          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }
      } catch (error) {
        setGlobal(key, previous);

        if (applied) {
          try {
            applyTools(ctx);

            if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
          } catch (restoreError) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}. Restoring the previous settings also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: error });
          }
        }
        throw error;
      }
    })();
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
