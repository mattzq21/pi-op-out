import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const STATUS_KEY = "pi-desktop-prompt-context";

async function loadCap(): Promise<number> {
  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cap = config && typeof config === "object" ? (config as Record<string, unknown>).contextWindowCap : undefined;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`${configPath}: contextWindowCap must be a positive integer`);
  }

  return cap;
}

function capModel(model: Model<any> | undefined, cap: number): boolean {
  if (!model || model.contextWindow <= cap) return false;
  model.contextWindow = Math.min(model.contextWindow, cap);
  return true;
}

function skillsFromPrompt(prompt: string) {
  const block = prompt.match(/\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/)?.[0] ?? "";
  const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  const skills = [...block.matchAll(/<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>[\s\S]*?<\/skill>/g)]
    .map((match) => ({ name: decode(match[1]), description: decode(match[2]), filePath: decode(match[3]) }));
  return { block, skills };
}

function instructionsFromPrompt(prompt: string) {
  const block = prompt.match(/\n\n<project_context>[\s\S]*?<\/project_context>\n?/)?.[0] ?? "";
  const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  const instructions = [...block.matchAll(/<project_instructions path="([^"]*)">\n?([\s\S]*?)\n?<\/project_instructions>/g)]
    .map((match) => ({ path: decode(match[1]), content: match[2] }));
  return { block, instructions };
}

export default async function contextWindowCap(pi: ExtensionAPI) {
  const cap = await loadCap();
  let lastStatus = "";

  const publishPromptContext = (ctx: ExtensionContext, persist = false) => {
    const systemPrompt = ctx.getSystemPrompt();
    const { block: skillPrompt, skills } = skillsFromPrompt(systemPrompt);
    const { block: instructionPrompt, instructions } = instructionsFromPrompt(systemPrompt);
    const activeTools = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
    const estimate = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
    const snapshot = {
      systemPrompt,
      instructions,
      tools,
      skills,
      tokens: { system: estimate(systemPrompt.replace(skillPrompt, "").replace(instructionPrompt, "")), instructions: estimate(instructionPrompt), tools: estimate(tools), skills: estimate(skillPrompt) },
    };
    if (persist) pi.appendEntry(STATUS_KEY, snapshot);
    const status = `json:${JSON.stringify(snapshot)}`;
    if (status !== lastStatus) { lastStatus = status; ctx.ui.setStatus(STATUS_KEY, status); }
  };

  pi.on("session_start", (_event, ctx) => {
    capModel(ctx.model, cap);
    lastStatus = "";
    setTimeout(() => { try { publishPromptContext(ctx); } catch { /* Session was replaced before the deferred snapshot. */ } }, 0);
  });

  pi.on("model_select", (event) => {
    capModel(event.model, cap);
  });

  pi.on("context", (_event, ctx) => {
    publishPromptContext(ctx, true);
  });
}
