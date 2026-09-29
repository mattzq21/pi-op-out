import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-desktop-prompt-context";
const PROJECT_CONTEXT_MESSAGE = "pi-desktop-project-context";

function skillsFromPrompt(prompt: string) {
  const block = prompt.match(/(?:\n\n)?The following skills provide specialized instructions[\s\S]*?<\/available_skills>/)?.[0] ?? "";
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

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
type SavedAgent = { snapshot?: { version: number; systemPrompt?: string; agentPrompt?: string; definition: { path_systemprompt: string; path_agentprompt?: string } } };

function section(system: SystemMessage, name: string) {
  const text = system.sections?.[name] ?? "";
  return text.replace(new RegExp(`^<${name}>\\n`), "").replace(new RegExp(`\\n</${name}>$`), "");
}

async function savedPrompt(state: SavedAgent, readPrompt: (path: string) => Promise<string>) {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  if (snapshot.version === 1) return { system: snapshot.systemPrompt ?? "", agent: snapshot.agentPrompt ?? "" };
  return { system: await readPrompt(snapshot.definition.path_systemprompt), agent: snapshot.definition.path_agentprompt ? await readPrompt(snapshot.definition.path_agentprompt) : "" };
}

async function recordedPrompt(branch: Branch, system: SystemMessage, readPrompt: (path: string) => Promise<string>) {
  const entry = branch.findLast(entry => entry.type === "custom" && entry.customType === "pi-define-agents-state");
  const prompt = entry?.type === "custom" ? await savedPrompt(entry.data as SavedAgent, readPrompt) : undefined;
  if (!prompt) return getSystemMessageText(system);
  return [prompt.system, section(system, "addendum"), section(system, "skills"), prompt.agent].filter(Boolean).join("\n\n");
}

function rolloutTurns(branch: Branch) {
  const resumeMessages = new Set(branch.flatMap(entry => {
    const message = entry.type === "custom" && entry.customType === "pi-desktop-resume" ? (entry.data as { message?: unknown })?.message : undefined;
    return typeof message === "string" ? [message] : [];
  }));
  const turns: Array<{ timestamp: number; end: number }> = [];
  let pending: number | undefined;
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user" && !resumeMessages.has(textContent(entry.message.content))) {
      if (pending !== undefined) turns.push({ timestamp: pending, end: index });
      pending = entry.message.timestamp;
    }
    if (entry.message.role === "assistant" && pending !== undefined) {
      turns.push({ timestamp: pending, end: index });
      pending = undefined;
    }
  }
  if (pending !== undefined) turns.push({ timestamp: pending, end: branch.length });
  return turns;
}

function contextDetails(systemPrompt: string, messages: unknown[], system: SystemMessage) {
    const { block: skillPrompt, skills } = skillsFromPrompt(systemPrompt);
    const { block: instructionPrompt, instructions } = instructionsFromPrompt(systemPrompt);
    const messageProjectContext = projectContextFromMessages(messages);
    const systemCwd = section(system, "cwd") || workingDirectoryFromPrompt(systemPrompt, instructionPrompt);
    if (!messageProjectContext.block && systemCwd) instructions.unshift({ path: "Working directory", content: displayPath(systemCwd) });
    else instructions.push(...messageProjectContext.instructions);
    const changeInstruction = changeInstructionFromMessages(messages);
    if (changeInstruction) instructions.push({ path: changeInstruction.path, content: changeInstruction.content });
    const tools = system.toolsAdded ?? [];
    const estimate = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
    return {
      systemPrompt,
      instructions,
      tools,
      skills,
      tokens: { system: estimate(systemPrompt.replace(skillPrompt, "").replace(instructionPrompt, "")), instructions: estimate(instructionPrompt) + estimate(messageProjectContext.block) + estimate(changeInstruction?.block ?? ""), tools: estimate(tools), skills: estimate(skillPrompt) },
    };
}

export default function contextBar(pi: ExtensionAPI) {
  const prompts = new Map<string, Promise<string>>();
  const readPrompt = (path: string) => {
    const base = process.env.PIOP_AGENT_CONFIG_PATH ? dirname(process.env.PIOP_AGENT_CONFIG_PATH) : join(dirname(fileURLToPath(import.meta.url)), "piop-define-agents");
    const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(base, path);
    let pending = prompts.get(absolute);
    if (!pending) { pending = readFile(absolute, "utf8"); prompts.set(absolute, pending); pending.catch(() => prompts.delete(absolute)); }
    return pending;
  };
  let revision = 0;
  let lastStatus: string | undefined;
  const publish = async (ctx: ExtensionContext) => {
    const current = ++revision;
    const branch = ctx.sessionManager.getBranch();
    const contexts = [];
    for (const turn of rolloutTurns(branch)) {
      const entries = branch.slice(0, turn.end);
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const system = getCurrentSystemMessage(messages);
      if (!system) continue;
      const systemPrompt = await recordedPrompt(entries, system, readPrompt);
      const customMessages = entries.flatMap<unknown>(entry => entry.type === "custom_message" ? [{ role: "custom", customType: entry.customType, content: entry.content }] : entry.type === "message" ? [entry.message] : []);
      contexts.push({ userTimestamp: turn.timestamp, ...contextDetails(systemPrompt, customMessages, system) });
    }
    const status = `json:${JSON.stringify({ contexts })}`;
    if (current === revision && status !== lastStatus) { lastStatus = status; ctx.ui.setStatus(STATUS_KEY, status); }
  };
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("session_tree", (_event, ctx) => publish(ctx));
  pi.on("message_start", (event, ctx) => { if (event.message.role === "assistant") return publish(ctx); });
  pi.on("agent_end", (_event, ctx) => publish(ctx));
  pi.on("session_shutdown", () => { revision += 1; prompts.clear(); });
}
