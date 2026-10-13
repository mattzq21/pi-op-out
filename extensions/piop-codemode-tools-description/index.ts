import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export default function codemodeToolsDescription(pi: ExtensionAPI) {
  let promptOptions: BuildSystemPromptOptions | undefined;

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
}
