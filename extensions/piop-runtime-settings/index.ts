import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { readFile as readSettings } from "./app-settings.cjs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, ExtensionCommandContext, InputEvent, InputEventResult, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { SkillsStoreRequest } from "../piop-skills-store/interface.ts";
import type { ToolStoreRequest } from "../piop-tool-store/interface.ts";

/** Settings this extension owns. Skills and tools in a settings update go to the skills store and tool store. */
type Settings = {
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

const settingsSchema = Type.Object({
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

function capabilitySummary(description: string) {
  const summary = description.trim().split(/\n|[.!?](?:\s|$)/, 1)[0].replace(/\s+/g, " ");

  return summary.length > 120 ? `${summary.slice(0, 117).replace(/\s+\S*$/, "")}...` : summary;
}

const abilitiesEntry = "piop-codemode-abilities";

const abilitiesSchema = Type.Object({
  tools: Type.Array(Type.String()),
  batches: Type.Array(Type.Object({ text: Type.String(), timestamp: Type.Number() })),
});

function availableCodemodeTool(tool: ReturnType<ExtensionAPI["getAllTools"]>[number], active: Set<string>, known: Set<string>) {
  const exposure = tool.exposure ?? "direct";

  return tool.name !== "codemode" && !known.has(tool.name) && (exposure === "codemode" || exposure === "deferred" || exposure === "direct" && active.has(tool.name));
}

function restoredCodemodeAbilities(ctx: ExtensionContext) {
  const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === abilitiesEntry);
  const saved = entry?.type === "custom" && Check(abilitiesSchema, entry.data) ? entry.data : { tools: [], batches: [] };

  return structuredClone(saved);
}

function codemodeAbilities(pi: ExtensionAPI, ctx: ExtensionContext) {
  const active = new Set(pi.getActiveTools());

  if (!active.has("codemode")) return;
  const state = restoredCodemodeAbilities(ctx);
  const known = new Set(state.tools);
  const phrases = new Set<string>();

  for (const tool of pi.getAllTools()) {
    if (!availableCodemodeTool(tool, active, known)) continue;
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

const promptValueSchema = Type.Cyclic({ Value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Undefined(), Type.Array(Type.Ref("Value")), Type.Record(Type.String(), Type.Ref("Value"))]) }, "Value");

type PromptValue = Static<typeof promptValueSchema>;

const providerPayloadSchema = Type.Record(Type.String(), promptValueSchema);

function replacePromptText(value: PromptValue, prompt: string, replacement: string): PromptValue {
  if (Check(Type.String(), value)) return value === prompt ? replacement : value;

  if (Array.isArray(value)) return value.map((item) => replacePromptText(item, prompt, replacement));

  if (value && Check(Type.Record(Type.String(), Type.Unknown()), value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replacePromptText(item, prompt, replacement)]));

  return value;
}

function updateProviderPrompt(payload: Static<typeof providerPayloadSchema>, prompt: string, replacement: string) {
  const updated = { ...payload };

  for (const key of ["instructions", "system", "systemInstruction"]) {
    if (key in updated) updated[key] = replacePromptText(updated[key], prompt, replacement);
  }

  for (const key of ["messages", "input"]) {
    const messages = updated[key];

    if (!Array.isArray(messages)) continue;
    updated[key] = messages.map((message) => Check(Type.Object({ role: Type.Union([Type.Literal("system"), Type.Literal("developer")]) }), message)
      ? replacePromptText(message, prompt, replacement) : message);
  }

  const config = updated.config;

  if (Check(Type.Record(Type.String(), Type.Unknown()), config) && "systemInstruction" in config) updated.config = { ...config, systemInstruction: replacePromptText(config.systemInstruction, prompt, replacement) };

  return updated;
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
  let promptOptions: BuildSystemPromptOptions | undefined;

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
  pi.on("before_agent_start", (event, ctx) => {
    promptOptions = event.systemPromptOptions;
    const batches = codemodeAbilities(pi, ctx);

    if (!batches) return;
    const options = event.systemPromptOptions;
    const instructions = options.sections?.codemode ?? pi.getAllTools().find((tool) => tool.name === "codemode")?.promptGuidelines?.join("\n");
    options.sections = { ...options.sections, codemode: [instructions, batches[0].text].filter(Boolean).join("\n\n") };
    options.toolGuidelines = { ...options.toolGuidelines, codemode: [] };

    for (let index = 1; index < batches.length; index++) options.sections[`codemode_abilities_${index}`] = batches[index].text;

    if (options.forceSystemPrompt !== undefined) options.forceSystemPrompt += `\n\n${Object.entries(options.sections).filter(([name]) => name === "codemode" || name.startsWith("codemode_abilities_")).map(([, value]) => value).join("\n\n")}`;
  });
  pi.on("context_with_system", (event, ctx) => {
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
  pi.on("before_provider_request", (event, ctx) => {
    if (promptOptions?.forceSystemPrompt === undefined) return;
    const batches = codemodeAbilities(pi, ctx);
    const prompt = ctx.getSystemPrompt();
    const additions = batches?.slice(1).filter((batch) => !prompt.includes(batch.text)).map((batch) => batch.text);

    if (!prompt || !additions?.length) return;

    if (Check(providerPayloadSchema, event.payload)) return updateProviderPrompt(event.payload, prompt, `${prompt}\n\n${additions.join("\n\n")}`);
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
          const changed: SettingsChanged = { ctx };
          pi.events.emit("piop:runtime-settings:changed", changed);
          await changed.ready;
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
