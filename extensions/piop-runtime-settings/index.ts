import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { readFile as readSettings } from "./app-settings.cjs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SkillsStoreRequest } from "../piop-skills-store/interface.ts";
import type { ToolStoreRequest } from "../piop-tool-store/interface.ts";

/** Settings this extension owns. Skills and tools in a settings update go to the skills store and tool store. */
type Settings = { defaultModel?: string };

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

const settingsSchema = Type.Object({ defaultModel: Type.Optional(Type.String()) });

const requestSchema = Type.Object({ settings: Type.Optional(Type.Unknown()), reloadAgents: Type.Optional(Type.Boolean()) });

const settingsPatchSchema = Type.Record(Type.String(), Type.Unknown());

const setGlobal = <T>(property: symbol, value: T) => Object.defineProperty(globalThis, property, { value, writable: true, configurable: true, enumerable: true });

function storedSettings() {
  const value = Object.getOwnPropertyDescriptor(globalThis, key)?.value;

  return Check(settingsSchema, value) ? value : undefined;
}

type RuntimeSettingsRequest = { settings?: Settings };

type RequiredToolsRequest = { ctx: ExtensionContext; tools: string[] };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:runtime-settings", handler: (request: RuntimeSettingsRequest) => void): () => void;
    emit(channel: "piop:runtime-settings", request: RuntimeSettingsRequest): void;
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

function validate(value: Settings): Settings {
  if (!Check(settingsSchema, value)) throw new Error("Invalid runtime settings");

  return structuredClone(value);
}

function skillsStore(pi: ExtensionAPI) {
  const request: SkillsStoreRequest = {};
  pi.events.emit("piop:skills-store", request);

  if (!request.store) throw new Error("The skills store extension is not loaded");

  return request.store;
}

function toolStore(pi: ExtensionAPI) {
  const request: ToolStoreRequest = {};
  pi.events.emit("piop:tool-store", request);

  if (!request.store) throw new Error("The tool store extension is not loaded");

  return request.store;
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

    if (process.env.PI_DEFINE_AGENTS_ACTIVE !== "1") pi.setActiveTools([...new Set([...toolStore(pi).lists().enabledTools, ...required.tools])].filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
  };

  pi.on("session_start", (_event, ctx) => {
    if (Object.getOwnPropertyDescriptor(globalThis, bootKey)?.value !== true) {
      const inherited = pi.getFlag("piop-runtime-settings");

      if (Check(Type.String(), inherited)) setGlobal(key, validate(JSON.parse(inherited)));
      setGlobal(bootKey, true);
    }

    applyTools(ctx);
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
      const skills = skillsStore(pi);
      const tools = toolStore(pi);
      const previousSkills = skills.lists();
      const previousTools = tools.lists();
      let applied = false;

      try {
        if (ctx.mode !== "rpc" || !ctx.isIdle()) throw new Error("Runtime settings require an idle RPC session");
        const patch = settingsRequest.settings ?? {};

        if (!Check(settingsPatchSchema, patch)) throw new Error("Invalid runtime settings");
        const { skills: skillLists, tools: toolLists, ...own } = patch;
        const next = validate({ ...previous, ...own });
        setGlobal(key, next);
        if (toolLists !== undefined) tools.replace(toolLists);
        const skillsChanged = skillLists !== undefined && skills.replace(skillLists);

        if (settingsRequest.reloadAgents || skillsChanged) {
          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:reload", ctx);
          else await ctx.reload();
        } else {
          applied = true;
          applyTools(ctx);

          if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") await update("piop:agents:refresh", ctx);
        }
      } catch (error) {
        setGlobal(key, previous);
        tools.replace(previousTools);
        skills.replace(previousSkills);

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
