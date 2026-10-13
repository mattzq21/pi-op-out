import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { readFile as readSettings } from "./app-settings.cjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, InputEvent, InputEventResult, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, formatDimensionNote, formatSkillsForPrompt, resizeImage } from "@earendil-works/pi-coding-agent";

type Settings = {
  tools: string[];
  skills: string[];
  explicitOnlySkills?: string[];
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
  /** Context caps by provider/model. A missing model inherits; null selects the model default. */
  modelContextWindowCaps: Record<string, number | null>;
};

type Update = { ctx: ExtensionCommandContext; ready?: Promise<void> };

/** Emitted after runtime settings change without a reload. Handlers may set ready; the settings request waits for it. */
type SettingsChanged = { ctx: ExtensionContext; ready?: Promise<void> };

interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
    emit(channel: "piop:rpc", request: AppRequest): void;
    on(channel: "piop:runtime-settings:changed", handler: (event: SettingsChanged) => void): () => void;
    emit(channel: "piop:runtime-settings:changed", event: SettingsChanged): void;
  }
}

const key = Symbol.for("piop.runtime-settings");

const bootKey = Symbol.for("piop.runtime-settings.boot");

const stringListSchema = Type.Array(Type.String());

const settingsSchema = Type.Object({
  tools: stringListSchema, skills: stringListSchema, explicitOnlySkills: Type.Optional(stringListSchema),
  contextWindowCap: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), contextWindowCapEnabled: Type.Boolean(),
  modelContextWindowCaps: Type.Record(Type.String(), Type.Union([Type.Null(), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })])),
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

async function resizeLargeImage(image: NonNullable<InputEvent["images"]>[number], model: NonNullable<ExtensionContext["model"]>) {
  const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
    ...model.inputLimits?.images?.resize, maxWidth: 2000, maxHeight: 2000,
  });

  if (!resized || (resized.originalWidth <= 2560 && resized.originalHeight <= 2560)) return;

  return { image: { ...image, data: resized.data, mimeType: resized.mimeType }, note: formatDimensionNote(resized) };
}

async function resizeLargeAttachments(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | undefined> {
  if (!event.images || !ctx.model) return;

  if (!ctx.model.input.includes("image")) return;
  const images: NonNullable<InputEvent["images"]> = [];
  const notes: string[] = [];

  for (const image of event.images) {
    const resized = await resizeLargeImage(image, ctx.model);
    images.push(resized?.image ?? image);

    if (resized?.note) notes.push(resized.note);
  }

  if (!notes.length) return;

  return { action: "transform", text: [event.text, ...notes].filter(Boolean).join("\n\n"), images };
}

async function resizeLargeToolImages(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
  if (!ctx.model?.input.includes("image")) return;
  const content: ToolResultEvent["content"] = [];
  let changed = false;

  for (const block of event.content) {
    const resized = block.type === "image" ? await resizeLargeImage(block, ctx.model) : undefined;
    content.push(resized?.image ?? block);

    if (resized) {
      changed = true;

      if (resized.note) content.push({ type: "text", text: resized.note });
    }
  }

  if (!changed) return;
  const image = content.find(block => block.type === "image");
  const structuredContent = event.toolName === "read" && image
    ? { ...image, note: content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") }
    : undefined;

  return { content, structuredContent };
}

function configureImageLimits(pi: ExtensionAPI) {
  type Model = NonNullable<ExtensionContext["model"]>;

  pi.registerTool(createReadToolDefinition(process.cwd(), { autoResizeImages: false }));
  pi.on("tool_result", (event, ctx) => {
    if (pi.getSettings().images?.autoResize === false) return;

    return resizeLargeToolImages(event, ctx);
  });

  const originals = new WeakMap<Model, Model["inputLimits"]>();

  const applyModel = (model: Model | undefined) => {
    if (!model?.input.includes("image")) return;

    if (!originals.has(model)) originals.set(model, model.inputLimits);
    const limits = model.inputLimits;
    model.inputLimits = { ...limits, images: { ...limits?.images, resize: { ...limits?.images?.resize, maxWidth: 2560, maxHeight: 2560 } } };
  };

  const apply = (ctx: ExtensionContext) => {
    for (const model of ctx.modelRegistry.getAll()) applyModel(model);
    applyModel(ctx.model);
  };

  pi.on("session_start", (_event, ctx) => { apply(ctx); });
  pi.on("model_select", (event, ctx) => { apply(ctx); applyModel(event.model); });
  pi.on("input", async (event, ctx) => {
    apply(ctx);

    if (pi.getSettings().images?.autoResize === false) return;

    return resizeLargeAttachments(event, ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => { apply(ctx); });
  const unsubscribe = pi.events.on("piop:models-refreshed", ({ ctx }) => { apply(ctx); });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribe();

    for (const model of new Set([...ctx.modelRegistry.getAll(), ctx.model])) {
      if (!model || !originals.has(model)) continue;
      model.inputLimits = originals.get(model);
      originals.delete(model);
    }
  });
}

export default async function runtimeSettings(pi: ExtensionAPI) {
  configureImageLimits(pi);
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
          const changed: SettingsChanged = { ctx };
          pi.events.emit("piop:runtime-settings:changed", changed);
          await changed.ready;
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
  pi.events.on("piop:rpc", request => {
    if (request.command !== "provider_auth_refresh") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      try {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        pi.events.emit("piop:models-refreshed", { ctx });
      } catch (error) {
        throw new Error(`Could not refresh provider models: ${error instanceof Error ? error.message : String(error)}. Reopen the conversation to retry.`, { cause: error });
      }
    })();
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
