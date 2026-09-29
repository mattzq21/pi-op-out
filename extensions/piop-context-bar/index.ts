import { homedir } from "node:os";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-desktop-prompt-context";
const PROJECT_CONTEXT_MESSAGE = "pi-desktop-project-context";

function skillsFromPrompt(prompt: string) {
  const block = prompt.match(/<skills>\s*[\s\S]*?<\/skills>/)?.[0]
    ?? prompt.match(/(?:^|\n\n)The following skills provide specialized instructions[\s\S]*?<\/available_skills>/)?.[0] ?? "";
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
  const agent = prompt.match(/<(instructions|agent_instructions)>\n([\s\S]*?)\n<\/\1>/);
  const blocks = [block, agent?.[0] ?? ""];
  return { block: blocks.join(""), blocks, instructions: [...projectInstructions(block), ...(agent ? [{ path: "Agent instructions", content: agent[2] }] : [])] };
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

function userInvokedSkills(messages: unknown[], options: BuildSystemPromptOptions | undefined, sinceCompaction?: Set<number>) {
  const available = new Map((options?.skills ?? []).map(skill => [`${skill.name}\0${skill.filePath}`, skill]));
  const invoked: Array<{ id: string; name: string; description: string; filePath: string; content: string }> = [];
  for (const [index, value] of messages.entries()) {
    const message = value as { role?: string; content?: unknown; timestamp?: number } | null;
    if (message?.role !== "user") continue;
    if (sinceCompaction && !sinceCompaction.has(message.timestamp!)) continue;
    const match = textContent(message.content).match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n[\s\S]*)?$/);
    if (!match) continue;
    const skill = available.get(`${match[1]}\0${match[2]}`);
    if (skill) invoked.push({ id: `${message.timestamp}:${index}`, name: skill.name, description: skill.description, filePath: skill.filePath, content: match[3] });
  }
  return invoked;
}

function invocationWindow(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
  const compacted = branch.findLastIndex(entry => entry.type === "compaction");
  if (compacted < 0) return undefined;
  return new Set(branch.slice(compacted + 1).flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [entry.message.timestamp] : []));
}

export default function contextBar(pi: ExtensionAPI) {
  let promptOptions: BuildSystemPromptOptions | undefined;
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
    const invokedSkills = userInvokedSkills(messages, promptOptions, invocationWindow(branch));
    const { block: instructionPrompt, blocks: instructionBlocks, instructions } = instructionsFromPrompt(systemPrompt);
    const messageProjectContext = projectContextFromMessages(messages);
    const systemCwd = workingDirectoryFromPrompt(systemPrompt, instructionPrompt);
    if (!messageProjectContext.block && systemCwd) instructions.unshift({ path: "Working directory", content: displayPath(systemCwd) });
    else instructions.push(...messageProjectContext.instructions);
    const changeInstruction = changeInstructionFromMessages(messages);
    if (changeInstruction) instructions.push({ path: changeInstruction.path, content: changeInstruction.content });
    const activeTools = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
    const estimate = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
    const skillTokens = { defined: estimate(skillPrompt), invoked: invokedSkills.reduce((sum, skill) => sum + estimate(skill.content), 0) };
    const snapshot = {
      userTimestamp: user.message.timestamp,
      systemPrompt,
      instructions,
      tools,
      skills,
      userInvokedSkills: invokedSkills,
      skillTokens,
      tokens: { system: estimate(instructionBlocks.reduce((prompt, block) => prompt.replace(block, ""), systemPrompt.replace(skillPrompt, ""))), instructions: estimate(instructionPrompt) + estimate(messageProjectContext.block) + estimate(changeInstruction?.block ?? ""), tools: estimate(tools), skills: skillTokens.defined + skillTokens.invoked },
    };
    pi.appendEntry(STATUS_KEY, snapshot);
    ctx.ui.setStatus(STATUS_KEY, `json:${JSON.stringify(snapshot)}`);
  };
  pi.on("session_start", (_event, ctx) => { promptOptions = undefined; ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("before_agent_start", (event) => { promptOptions = event.systemPromptOptions; });
  pi.on("context", (event, ctx) => { publishPromptContext(ctx, event.messages); });
}
