import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { homedir } from "node:os";
import type { BuildSystemPromptOptions, ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContextMessages = ContextEvent["messages"];

const contentSchema = Type.Union([Type.String(), Type.Array(Type.Unknown())]);

const textPartSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

const messageProperties = { role: Type.Optional(Type.String()), customType: Type.Optional(Type.String()), content: Type.Optional(contentSchema) };

const envelopeSchema = Type.Object({ ...messageProperties, type: Type.Optional(Type.String()), message: Type.Optional(Type.Object(messageProperties)) });

const userMessageSchema = Type.Object({ role: Type.Literal("user"), content: Type.Optional(contentSchema), timestamp: Type.Optional(Type.Number()) });

const changeMessageSchema = Type.Object({ role: Type.Literal("custom"), customType: Type.Literal("pi-project-files-watch"), content: Type.Optional(contentSchema) });

const resumeSchema = Type.Object({ message: Type.String() });

const responseUsageSchema = Type.Object({ response: Type.Object({ usage: Type.Object({ input_tokens: Type.Integer({ minimum: 1 }) }) }) });

const savedContextSchema = Type.Object({
  systemPrompt: Type.Optional(Type.String()), tools: Type.Optional(Type.Array(Type.Unknown())),
  sameAsPrevious: Type.Optional(Type.Object({ systemPrompt: Type.Optional(Type.Boolean()), tools: Type.Optional(Type.Boolean()) })),
});

const STATUS_KEY = "pi-desktop-prompt-context";

const ENTRY_TYPE = "piop-context";

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

function textContent(content: Static<typeof contentSchema> | undefined) {
  if (!Array.isArray(content)) return content ?? "";

  return content.flatMap(part => Check(textPartSchema, part) ? [part.text] : []).join("\n");
}

function customMessageContent(value: ContextMessages[number], customType: string) {
  if (!Check(envelopeSchema, value)) return undefined;
  const entry: Static<typeof envelopeSchema> = value;

  if (entry.type === "message" && entry.message?.role === "custom" && entry.message.customType === customType) return textContent(entry.message.content);

  if ((entry.type === "custom_message" || entry.role === "custom") && entry.customType === customType) return textContent(entry.content);

  return undefined;
}

function latestCustomMessage(values: Readonly<ContextMessages>, customType: string) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const content = customMessageContent(values[index], customType);

    if (content !== undefined) return content;
  }

  return undefined;
}

function projectContextFromMessages(messages: Readonly<ContextMessages>) {
  const block = latestCustomMessage(messages, PROJECT_CONTEXT_MESSAGE) ?? "";

  if (!block) return { block, instructions: [] };
  const cwd = block.match(/^<project_context>\nCurrent working directory: ([^\n]*)/)?.[1];

  return { block, instructions: [...(cwd ? [{ path: "Working directory", content: displayPath(cwd) }] : []), ...projectInstructions(block)] };
}

function changeInstructionFromMessages(messages: ContextMessages) {
  let latestUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (Check(userMessageSchema, message)) { latestUserIndex = index; break; }
  }

  if (latestUserIndex < 0) return undefined;
  const changeMessage = messages.slice(latestUserIndex + 1).find(message => Check(changeMessageSchema, message));

  if (!Check(changeMessageSchema, changeMessage)) return undefined;
  const text = textContent(changeMessage.content);
  const match = text.match(/^<project_context>\n([\s\S]*?)\n<\/project_context>$/);

  return match ? { path: "File changes", content: match[1], block: match[0] } : undefined;
}

function userInvokedSkills(messages: ContextMessages, options: BuildSystemPromptOptions | undefined, sinceCompaction?: Set<number>) {
  const available = new Map((options?.skills ?? []).map(skill => [`${skill.name}\0${skill.filePath}`, skill]));
  const invoked: Array<{ id: string; name: string; description: string; filePath: string; content: string }> = [];

  for (const [index, message] of messages.entries()) {
    if (!Check(userMessageSchema, message)) continue;

    if (sinceCompaction && (message.timestamp === undefined || !sinceCompaction.has(message.timestamp))) continue;
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

/** Returns the system prompt and tools of the latest saved snapshot on the branch, following "same as previous" markers. */
function savedPromptParts(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
  let systemPrompt: string | undefined;
  let tools: string | undefined;

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !Check(savedContextSchema, entry.data)) continue;
    const data = entry.data;

    if (!data.sameAsPrevious?.systemPrompt) systemPrompt = data.systemPrompt;

    if (!data.sameAsPrevious?.tools) tools = data.tools === undefined ? undefined : JSON.stringify(data.tools);
  }

  return { systemPrompt, tools };
}

type RequestTool = { name: string; description: string; parameters?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The tools a provider request declares to the model, as sent: OpenAI chat and responses, Anthropic and Google request shapes.
 * Undefined when the request has no tool list this reads.
 */
function requestTools(payload: unknown): RequestTool[] | undefined {
  if (!isRecord(payload)) return undefined;
  const lists = [payload.tools, isRecord(payload.config) ? payload.config.tools : undefined].filter(Array.isArray);

  if (!lists.length) return undefined;
  const tools: RequestTool[] = [];
  const add = (value: unknown) => {
    if (!isRecord(value) || typeof value.name !== "string") return;
    tools.push({ name: value.name, description: typeof value.description === "string" ? value.description : "", parameters: value.parameters ?? value.input_schema ?? value.parametersJsonSchema });
  };

  for (const item of lists.flat()) {
    if (!isRecord(item)) continue;

    if (Array.isArray(item.functionDeclarations)) item.functionDeclarations.forEach(add);
    else add(isRecord(item.function) ? item.function : item);
  }

  return tools;
}

/** Messages from other agent sessions that start a turn: orchestration messages and subagent results. */
const AGENT_MESSAGES = new Set(["piop-agent-message", "piop-subagent-result"]);

const agentMessageDetails = Type.Object({ notificationId: Type.String() });

export default function contextBar(pi: ExtensionAPI) {
  let promptOptions: BuildSystemPromptOptions | undefined;
  let publishInputTokens: ((tokens: number, ctx: ExtensionContext) => void) | undefined;
  /** The snapshot of the latest user message until its first model request is sent. It is saved with the tools of that request. */
  let pending: { save: (sent: RequestTool[] | undefined, ctx: ExtensionContext) => void } | undefined;

  const publishPromptContext = (ctx: ExtensionContext, messages: ContextMessages) => {
    const branch = ctx.sessionManager.getBranch();

    const resumeMessages = new Set(branch.flatMap((entry) => {
      return entry.type === "custom" && entry.customType === "pi-desktop-resume" && Check(resumeSchema, entry.data) ? [entry.data.message] : [];
    }));

    // A turn starts with a user message, or with a message or result from another agent session.
    const userIndex = branch.findLastIndex((entry) => (entry.type === "message" && entry.message.role === "user" && !resumeMessages.has(textContent(entry.message.content))) || (entry.type === "custom_message" && AGENT_MESSAGES.has(entry.customType)));
    const user = branch[userIndex];
    const anchor = user?.type === "message" ? { userTimestamp: user.message.timestamp } : user?.type === "custom_message" && Check(agentMessageDetails, user.details) ? { agentNotificationId: user.details.notificationId } : undefined;

    if (!anchor) return;

    if (branch.slice(userIndex + 1).some((entry) => entry.type === "custom" && [ENTRY_TYPE, STATUS_KEY].includes(entry.customType))) return;
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
    const codemode = activeTools.has("codemode");
    // Codemode scripts can call every active direct tool, but no model-only tool.
    const inCodemode = (tool: { name: string; exposure?: string }) => tool.name !== "codemode" && tool.exposure !== "model-only";
    const activeInfo = pi.getAllTools().filter((tool) => activeTools.has(tool.name));
    const tools = activeInfo.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, ...codemode && tool.name !== "codemode" ? { codemode: inCodemode(tool) } : {} }));
    const codemodeFlags = new Map(tools.map(tool => [tool.name, tool.codemode]));
    const estimate = (value: string) => Math.ceil(value.length / 4);
    const skillTokens = { defined: estimate(skillPrompt), invoked: invokedSkills.reduce((sum, skill) => sum + estimate(skill.content), 0) };

    const snapshot = {
      ...anchor,
      systemPrompt,
      instructions,
      tools,
      skills,
      userInvokedSkills: invokedSkills,
      skillTokens,
      tokens: { system: estimate(instructionBlocks.reduce((prompt, block) => prompt.replace(block, ""), systemPrompt.replace(skillPrompt, ""))), instructions: estimate(instructionPrompt) + estimate(messageProjectContext.block) + estimate(changeInstruction?.block ?? ""), tools: estimate(JSON.stringify(tools)), skills: skillTokens.defined + skillTokens.invoked },
    };

    const publish = (context: ExtensionContext) => {
      context.ui.setStatus(STATUS_KEY, `json:${JSON.stringify(snapshot)}`);
      publishInputTokens = (inputTokens, next) => next.ui.setStatus(STATUS_KEY, `json:${JSON.stringify({ ...snapshot, inputTokens })}`);
    };

    publish(ctx);
    pending = { save(sent, context) {
      if (sent) {
        snapshot.tools = sent.map(tool => ({ ...tool, ...codemodeFlags.get(tool.name) === undefined ? {} : { codemode: codemodeFlags.get(tool.name) } }));
        snapshot.tokens.tools = estimate(JSON.stringify(sent));
      }

      const previous = savedPromptParts(context.sessionManager.getBranch());
      const sameSystemPrompt = previous.systemPrompt === systemPrompt;
      const sameTools = previous.tools === JSON.stringify(snapshot.tools);
      const { systemPrompt: _systemPrompt, tools: savedTools, ...rest } = snapshot;
      pi.appendEntry(ENTRY_TYPE, {
        ...rest,
        ...sameSystemPrompt ? {} : { systemPrompt },
        ...sameTools ? {} : { tools: savedTools },
        ...sameSystemPrompt || sameTools ? { sameAsPrevious: { ...sameSystemPrompt ? { systemPrompt: true } : {}, ...sameTools ? { tools: true } : {} } } : {},
      });
      publish(context);
    } };
  };

  pi.on("session_start", (_event, ctx) => { promptOptions = undefined; publishInputTokens = undefined; pending = undefined; ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("before_agent_start", (event) => { promptOptions = event.systemPromptOptions; });
  pi.on("context", (event, ctx) => { publishPromptContext(ctx, event.messages); });
  pi.on("before_provider_request", (event, ctx) => {
    const current = pending;
    pending = undefined;
    current?.save(requestTools(event.payload), ctx);
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (!publishInputTokens || !["openai-responses", "openai-codex-responses"].includes(event.api) || !Check(responseUsageSchema, event.data)) return;
    publishInputTokens(event.data.response.usage.input_tokens, ctx);
    publishInputTokens = undefined;
  });
  pi.on("message_end", (event) => { if (event.message.role === "assistant") publishInputTokens = undefined; });
  pi.on("agent_end", () => { publishInputTokens = undefined; });
}
