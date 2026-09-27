import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const STATUS_KEY = "pi-desktop-prompt-context";
const PROJECT_CONTEXT_MESSAGE = "pi-desktop-project-context";
const CAP_ENTRY = "piop-session-context-cap";

async function loadCap(): Promise<number | undefined> {
  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const values = config && typeof config === "object" ? config as Record<string, unknown> : {};
  if (values.enabled === false) return undefined;
  const cap = values.contextWindowCap;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`${configPath}: contextWindowCap must be a positive integer`);
  }

  return cap;
}

function skillsFromPrompt(prompt: string) {
  const block = prompt.match(/\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/)?.[0] ?? "";
  const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  const skills = [...block.matchAll(/<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>[\s\S]*?<\/skill>/g)]
    .map((match) => ({ name: decode(match[1]), description: decode(match[2]), filePath: decode(match[3]) }));
  return { block, skills };
}

function decodeXml(value: string) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function displayPath(value: string) {
  const home = homedir();
  return value === home ? "~" : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function projectInstructions(block: string) {
  return [...block.matchAll(/<project_instructions path="([^"]*)">\n?([\s\S]*?)\n?<\/project_instructions>/g)]
    .map((match) => ({ path: displayPath(decodeXml(match[1])), content: match[2] }));
}

function instructionsFromPrompt(prompt: string) {
  const block = prompt.match(/\n\n<project_context>[\s\S]*?<\/project_context>\n?/)?.[0] ?? "";
  return { block, instructions: projectInstructions(block) };
}

function workingDirectoryFromPrompt(prompt: string, projectContext: string) {
  return projectContext.match(/\nCurrent working directory: ([^\n]*)/)?.[1] ?? prompt.match(/\nCurrent working directory: ([^\n]*)\n?$/)?.[1];
}

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n");
}

function customMessageContent(value: unknown, customType: string) {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; role?: unknown; customType?: unknown; message?: { role?: unknown; customType?: unknown; content?: unknown }; content?: unknown };
  if (entry.type === "message" && entry.message?.role === "custom" && entry.message.customType === customType) return textContent(entry.message.content);
  if ((entry.type === "custom_message" || entry.role === "custom") && entry.customType === customType) return textContent(entry.content);
  return undefined;
}

function latestCustomMessage(values: readonly unknown[], customType: string) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const content = customMessageContent(values[index], customType);
    if (content !== undefined) return content;
  }
  return undefined;
}

function movableProjectContext(prompt: string, cwd: string) {
  const { block } = instructionsFromPrompt(prompt);
  const withoutInstructions = block ? prompt.replace(block, "\n") : prompt;
  const stablePrompt = withoutInstructions.replace(/\nCurrent working directory: [^\n]*\n?$/, "");
  const content = `<project_context>\nCurrent working directory: ${cwd}\n</project_context>`;
  return { stablePrompt, content };
}

function projectContextFromMessages(messages: readonly unknown[]) {
  const block = latestCustomMessage(messages, PROJECT_CONTEXT_MESSAGE) ?? "";
  if (!block) return { block, instructions: [] as Array<{ path: string; content: string }> };
  const cwd = block.match(/^<project_context>\nCurrent working directory: ([^\n]*)/)?.[1];
  return { block, instructions: [...(cwd ? [{ path: "Working directory", content: displayPath(cwd) }] : []), ...projectInstructions(block)] };
}

function changeInstructionFromMessages(messages: unknown[]) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") { latestUserIndex = index; break; }
  }
  if (latestUserIndex < 0) return undefined;
  const changeMessage = messages.slice(latestUserIndex + 1).find((message) => message && typeof message === "object" && (message as { role?: unknown; customType?: unknown }).role === "custom" && (message as { customType?: unknown }).customType === "pi-project-files-watch") as { content?: unknown } | undefined;
  if (!changeMessage) return undefined;
  const text = textContent(changeMessage.content);
  const match = text.match(/^<project_context>\n([\s\S]*?)\n<\/project_context>$/);
  return match ? { path: "File changes", content: match[1], block: match[0] } : undefined;
}

function savedCap(data: unknown) {
  const saved = (data as { cap?: unknown } | undefined)?.cap;
  if (saved !== null && (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 1000)) throw new Error("Invalid saved session context cap");
  return saved === null ? undefined : saved as number;
}

function precedingUser(messages: unknown[], contextIndex: number) {
  for (let index = contextIndex - 1; index >= 0; index -= 1) {
    if (messages[index] && typeof messages[index] === "object" && (messages[index] as { role?: unknown }).role === "user") return index;
  }
  return -1;
}

export default async function contextWindowCap(pi: ExtensionAPI) {
  const settings = () => { const request: { settings?: { contextWindowCap: number; contextWindowCapEnabled: boolean } } = {}; pi.events.emit("piop:runtime-settings", request); return request.settings; };
  const initial = settings();
  let cap = initial ? (initial.contextWindowCapEnabled ? initial.contextWindowCap : undefined) : await loadCap();
  const originalWindows = new Map<{ contextWindow: number }, number>();
  pi.on("input", (event, ctx) => {
    capModel(ctx.model);
    if (cap === undefined || event.text.startsWith("/")) return;
    const budgets = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings();
    const minimum = budgets.reserveTokens + budgets.keepRecentTokens + 1;
    if (cap >= minimum) return;
    const error = `This conversation's ${cap.toLocaleString()}-token context cap is too small for Pi's compaction budgets. Start a conversation with a cap of at least ${minimum.toLocaleString()} tokens, or reduce Pi's reserve and recent-history budgets.`;
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error }));
    ctx.ui.notify(error, "error");
    return { action: "handled" };
  });
  const capModel = (model: { contextWindow: number } | undefined) => {
    if (!model) return;
    if (!originalWindows.has(model)) originalWindows.set(model, model.contextWindow);
    const original = originalWindows.get(model)!;
    model.contextWindow = cap === undefined ? original : Math.min(original, cap);
  };
  const restoreCap = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === CAP_ENTRY);
    if (entry?.type === "custom") {
      cap = savedCap(entry.data);
    } else {
      const defaults = settings();
      if (defaults) cap = defaults.contextWindowCapEnabled ? defaults.contextWindowCap : undefined;
      pi.appendEntry(CAP_ENTRY, { cap: cap ?? null });
    }
    for (const model of originalWindows.keys()) capModel(model);
    capModel(ctx.model);
  };
  pi.on("session_shutdown", () => { for (const [model, original] of originalWindows) model.contextWindow = original; });
  const unsubscribeModels = pi.events.on("piop:models-refreshed", (value) => { capModel((value as { ctx: ExtensionContext }).ctx.model); });
  pi.on("session_shutdown", () => { unsubscribeModels(); });
  const publishPromptContext = (ctx: ExtensionContext, messages: unknown[]) => {
    const branch = ctx.sessionManager.getBranch();
    const resumeMessages = new Set(branch.flatMap((entry) => {
      const message = entry.type === "custom" && entry.customType === "pi-desktop-resume" ? (entry.data as { message?: unknown })?.message : undefined;
      return typeof message === "string" ? [message] : [];
    }));
    const userIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user" && !resumeMessages.has(textContent(entry.message.content)));
    const user = branch[userIndex];
    if (!user || user.type !== "message") return;
    if (branch.slice(userIndex + 1).some((entry) => entry.type === "custom" && entry.customType === STATUS_KEY)) return;
    const systemPrompt = ctx.getSystemPrompt();
    const { block: skillPrompt, skills } = skillsFromPrompt(systemPrompt);
    const { block: instructionPrompt, instructions } = instructionsFromPrompt(systemPrompt);
    const messageProjectContext = projectContextFromMessages(messages);
    const systemCwd = workingDirectoryFromPrompt(systemPrompt, instructionPrompt);
    if (!messageProjectContext.block && systemCwd) instructions.unshift({ path: "Working directory", content: displayPath(systemCwd) });
    else instructions.push(...messageProjectContext.instructions);
    const changeInstruction = changeInstructionFromMessages(messages);
    if (changeInstruction) instructions.push({ path: changeInstruction.path, content: changeInstruction.content });
    const activeTools = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
    const estimate = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
    const snapshot = {
      userTimestamp: user.message.timestamp,
      systemPrompt,
      instructions,
      tools,
      skills,
      tokens: { system: estimate(systemPrompt.replace(skillPrompt, "").replace(instructionPrompt, "")), instructions: estimate(instructionPrompt) + estimate(messageProjectContext.block) + estimate(changeInstruction?.block ?? ""), tools: estimate(tools), skills: estimate(skillPrompt) },
    };
    pi.appendEntry(STATUS_KEY, snapshot);
    ctx.ui.setStatus(STATUS_KEY, `json:${JSON.stringify(snapshot)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    restoreCap(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("session_tree", (_event, ctx) => { restoreCap(ctx); });

  pi.on("model_select", (event) => {
    capModel(event.model);
  });

  pi.on("before_agent_start", (event, ctx) => {
    capModel(ctx.model);
    if (process.env.PI_DEFINE_AGENTS_ACTIVE === "1") return;
    const projectContext = movableProjectContext(event.systemPrompt, ctx.cwd);
    const previous = latestCustomMessage(ctx.sessionManager.buildContextEntries(), PROJECT_CONTEXT_MESSAGE);
    return {
      systemPrompt: projectContext.stablePrompt,
      ...(previous === projectContext.content ? {} : { message: { customType: PROJECT_CONTEXT_MESSAGE, content: projectContext.content, display: false } }),
    };
  });

  pi.on("context", (event, ctx) => {
    let messages = process.env.PI_DEFINE_AGENTS_ACTIVE === "1"
      ? event.messages.filter((message) => customMessageContent(message, PROJECT_CONTEXT_MESSAGE) === undefined)
      : event.messages;
    let contextIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (customMessageContent(messages[index], PROJECT_CONTEXT_MESSAGE) !== undefined) { contextIndex = index; break; }
    }
    if (contextIndex >= 0) {
      const userIndex = precedingUser(messages, contextIndex);
      if (userIndex >= 0 && contextIndex === userIndex + 1) {
        messages = [...messages];
        const [context] = messages.splice(contextIndex, 1);
        messages.splice(userIndex, 0, context);
      }
    }
    publishPromptContext(ctx, messages);
    if (messages !== event.messages) return { messages };
  });
}
