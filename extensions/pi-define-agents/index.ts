import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Agent = { name: string; description: string; model: string; effort: string; systemPrompt?: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[] };
type RuntimeDefaults = { model: string; effort: string };


const STATUS_KEY = "pi-define-agents";
const STATE_ENTRY = "pi-define-agents-state";
const DEFAULTS_ENV = "PI_DEFINE_AGENTS_RUNTIME_DEFAULTS";
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant operating inside a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:

- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:

- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files`;

type Config = { agents: Agent[]; webSearchDefaultApplied?: boolean };
const fallbackConfig: Config = { agents: [{ name: "default", description: "General-purpose agent", model: "", effort: "high", agentsMd: "", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: [] }] };
function defaultAgent(): Agent {
  const agent = structuredClone(fallbackConfig.agents[0]);
  if (desktopList("PI_DESKTOP_ALLOWED_TOOLS")?.includes("web_search")) agent.tools.push("web_search");
  return agent;
}

async function writeConfig(value: Config, createOnly = false) {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (createOnly) {
      // Publish a complete file without replacing a concurrent migration's result.
      try { await link(temporary, configPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else await rename(temporary, configPath);
  } finally { await rm(temporary, { force: true }); }
}

// Collapse the retired field at the storage boundary; runtime profiles have one prompt.
function systemPromptFromStoredAgent(agent: Agent & { developerPrompt?: unknown }): string | undefined {
  const prompt = typeof agent.systemPrompt === "string" ? agent.systemPrompt : undefined;
  const legacy = typeof agent.developerPrompt === "string" ? agent.developerPrompt : "";
  if ("developerPrompt" in agent) {
    // Profiles from before the single-prompt format used blank to inherit.
    const inherited = prompt?.trim() ? prompt : undefined;
    return legacy.trim() ? `${inherited ?? DEFAULT_SYSTEM_PROMPT}\n\n${legacy}` : inherited;
  }
  return prompt;
}

function normalize(value: Partial<Config>): Config {
  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => agent && typeof agent.name === "string" && agent.name.length > 0).map((agent) => ({
    name: agent.name, description: typeof agent.description === "string" ? agent.description : "", model: typeof agent.model === "string" ? agent.model : "", effort: typeof agent.effort === "string" ? agent.effort : fallbackConfig.agents[0].effort,
    systemPrompt: systemPromptFromStoredAgent(agent), agentsMd: typeof agent.agentsMd === "string" ? agent.agentsMd : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => typeof item === "string") : defaultAgent().tools, skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => typeof item === "string") : [], mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers.filter((item): item is string => typeof item === "string" && item !== "filesystem") : [],
  })) : [];
  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "default") ? unique : [defaultAgent(), ...unique];
  return { agents, webSearchDefaultApplied: value.webSearchDefaultApplied === true };
}

async function readConfig(): Promise<Config> {
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    const config = normalize(stored);
    if (Array.isArray(stored.agents) && stored.agents.some((agent: unknown) => agent && typeof agent === "object" && "developerPrompt" in agent)) await writeConfig(config);
    return config;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Preserve profiles from older installations without changing their legacy data.
  const legacyPath = join(dirname(configPath), "..", "pi-orchestration", "config.json");
  let legacy: Partial<Config> = {};
  try { legacy = JSON.parse(await readFile(legacyPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeConfig(normalize({ agents: legacy.agents }), true);
  return normalize(JSON.parse(await readFile(configPath, "utf8")));
}
async function loadConfig(): Promise<Config> {
  const config = await readConfig();
  let changed = false;
  for (const agent of config.agents) {
    if (!agent.tools.some((tool) => tool === "exec_command" || tool === "apply_patch")) continue;
    agent.tools = [...new Set(agent.tools.flatMap((tool) => tool === "exec_command"
      ? ["read", "bash", "grep", "find", "ls"]
      : tool === "apply_patch" ? ["edit", "write"] : [tool]))];
    changed = true;
  }
  if (!config.webSearchDefaultApplied && desktopList("PI_DESKTOP_ALLOWED_TOOLS")?.includes("web_search")) {
    for (const agent of config.agents) if (!agent.tools.includes("web_search")) agent.tools.push("web_search");
    config.webSearchDefaultApplied = true;
    changed = true;
  }
  if (changed) await writeConfig(config);
  return config;
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode<T>(value: string): T { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; }
function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"; }
function desktopList(name: string) { try { const value = JSON.parse(process.env[name] || "null"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined; } catch { return undefined; } }
function normalizedPath(value: string) { return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }
function agentSkills(agent: Agent) { const global = desktopList("PI_DESKTOP_SKILL_PATHS"); if (!global) return agent.skills; const allowed = new Set(global.map(normalizedPath)); return agent.skills.filter((skill) => allowed.has(normalizedPath(skill))); }
function agentToolError(pi: ExtensionAPI, agent: Agent) {
  const globallyAllowed = desktopList("PI_DESKTOP_ALLOWED_TOOLS"); const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const denied = [...new Set(agent.tools.filter((tool) => (globallyAllowed && !globallyAllowed.includes(tool)) || !available.has(tool)))];
  return denied.length ? `Agent "${agent.name}" cannot run because Pi does not allow its configured tool${denied.length === 1 ? "" : "s"}: ${denied.join(", ")}` : undefined;
}

// Keep Pi's discovered context and skills when replacing an agent's base instructions.
function buildAgentSystemPrompt(prompt: string, options: BuildSystemPromptOptions, currentPrompt: string): string {
  const sections = [prompt];
  if (options.appendSystemPrompt) sections.push(options.appendSystemPrompt);
  // The context-window extension may already have moved these into a context message.
  const projectContext = currentPrompt.match(/\n\n(<project_context>[\s\S]*?<\/project_context>)/)?.[1];
  if (projectContext) sections.push(projectContext);
  const readTool = (["read", "bash"] as const).find((tool) => (options.selectedTools ?? ["read", "bash", "edit", "write"]).includes(tool));
  if (readTool && options.skills?.length) sections.push(formatSkillsForPrompt(options.skills, readTool));
  return sections.join("\n\n");
}

export default async function defineAgents(pi: ExtensionAPI) {
  let config = await loadConfig();
  let active = "default";
  let runtimeDefaults: RuntimeDefaults | undefined;
  let runtimeSession = "";
  let applyingAgentModel: string | undefined;
  let applyingAgentEffort: string | undefined;
  let activeToolError: string | undefined;
  let modelOverride: string | undefined;
  let effortOverride: string | undefined;
  let reloading = false;
  process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const currentAgent = () => findAgent(active);
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active: currentAgent()?.name ?? active, config })}`);
  const reload = async (ctx: ExtensionContext) => {
    // Reloading resources does not invalidate the definitions already loaded.
    publish(ctx);
    reloading = true;
    try { await ctx.reload(); } finally { reloading = false; }
  };
  const saveRuntimeDefaults = (value: RuntimeDefaults) => { runtimeDefaults = value; process.env[DEFAULTS_ENV] = JSON.stringify({ ...value, session: runtimeSession }); };
  const restore = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionFile() || "";
    if (runtimeDefaults && runtimeSession === session) return;
    runtimeSession = session;
    runtimeDefaults = undefined;
    try { const stored = JSON.parse(process.env[DEFAULTS_ENV] || "null"); if (stored?.session === session && typeof stored.model === "string" && typeof stored.effort === "string") runtimeDefaults = { model: stored.model, effort: stored.effort }; } catch { /* Capture clean runtime defaults below. */ }
    if (!runtimeDefaults) saveRuntimeDefaults({ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", effort: pi.getThinkingLevel() });
  };
  const activate = async (agent: Agent, ctx: ExtensionContext) => {
    const toolError = agentToolError(pi, agent); if (toolError) { pi.setActiveTools([]); return toolError; }
    const modelName = modelOverride || agent.model.trim() || runtimeDefaults?.model; const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    if (modelName && modelName !== currentModel) {
      const [provider, ...parts] = modelName.split("/"); const model = ctx.modelRegistry.find(provider, parts.join("/"));
      if (!model) { pi.setActiveTools([]); return `Agent "${agent.name}" cannot run because model ${modelName} is unavailable`; }
      try { applyingAgentModel = modelName; const selected = await pi.setModel(model); if (!selected) { applyingAgentModel = undefined; pi.setActiveTools([]); return `Agent "${agent.name}" cannot authenticate model ${modelName}`; } } catch (error) { if (applyingAgentModel === modelName) applyingAgentModel = undefined; pi.setActiveTools([]); return `Agent "${agent.name}" could not select ${modelName}: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const effort = effortOverride || agent.effort.trim() || runtimeDefaults?.effort; if (effort && effort !== pi.getThinkingLevel()) { applyingAgentEffort = effort; pi.setThinkingLevel(effort as any); }
    pi.setActiveTools([]);
    const tools = new Set(agent.tools);
    if (process.env.PI_DESKTOP_MCP_CONFIG) {
      const selection: { serverIds: string[]; agentName: string; sessionId: string; ready?: Promise<string[]> } = { serverIds: agent.mcpServers, agentName: agent.name, sessionId: ctx.sessionManager.getSessionId() };
      pi.events.emit("piop:mcp:select", selection);
      if (!selection.ready) return `Agent "${agent.name}" cannot run because the MCP bridge is unavailable`;
      try { for (const tool of await selection.ready) tools.add(tool); }
      catch (error) { pi.setActiveTools([]); return `Agent "${agent.name}" could not connect its MCP servers: ${error instanceof Error ? error.message : String(error)}`; }
    } else {
      for (const info of pi.getAllTools()) if (agent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) tools.add(info.name);
    }
    pi.setActiveTools([...tools]); return undefined;
  };
  const useAgent = async (name: string, ctx: ExtensionContext) => {
    restore(ctx);
    const agent = findAgent(name);
    activeToolError = agent ? await activate(agent, ctx) : `Unknown defined agent: ${name}`;
    if (activeToolError) pi.setActiveTools([]);
    publish(ctx);
    return activeToolError;
  };
  pi.on("model_select", (event) => { const model = `${event.model.provider}/${event.model.id}`; if (applyingAgentModel === model) { applyingAgentModel = undefined; return; } modelOverride = model; saveRuntimeDefaults({ model, effort: runtimeDefaults?.effort || pi.getThinkingLevel() }); });
  pi.on("thinking_level_select", (event) => { if (applyingAgentEffort === event.level) { applyingAgentEffort = undefined; return; } effortOverride = event.level; saveRuntimeDefaults({ model: runtimeDefaults?.model || "", effort: event.level }); });
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    active = "default";
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && (entry.customType === STATE_ENTRY || entry.customType === "pi-orchestration-state")) {
      const name = (entry.data as { active?: string })?.active;
      if (name && findAgent(name)) active = name;
    }
    // Configuration is ready even when activating its MCP servers takes longer.
    publish(ctx);
    await useAgent(active, ctx);
    publish(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { delete process.env.PI_DEFINE_AGENTS_ACTIVE; if (!reloading) ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("resources_discover", () => { const agent = currentAgent(); const skillPaths = agent ? agentSkills(agent) : []; return skillPaths.length ? { skillPaths } : undefined; });
  pi.on("input", async (event, ctx) => {
    const error = await useAgent(active, ctx);
    if (error) { ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error })); ctx.ui.notify(error, "error"); return { action: "handled" }; }
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    const agent = currentAgent(); if (!agent) return;
    const base = buildAgentSystemPrompt(agent.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, event.systemPromptOptions, event.systemPrompt);
    const additions = agent.agentsMd.trim() ? `# Agent AGENTS.md\n\n${agent.agentsMd}` : "";
    const systemPrompt = additions ? `${base}\n\n${additions}` : base;
    return { systemPrompt: `${systemPrompt}\n\nCurrent working directory ${ctx.cwd.replace(/\\/g, "/")}` };
  });
  pi.registerCommand("pi-define-agents-use", { description: "Select a defined agent", handler: async (args, ctx) => {
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* Plain CLI name. */ }
    if (!findAgent(name)) throw new Error(`Unknown defined agent: ${name}`);
    active = name; modelOverride = undefined; effortOverride = undefined;
    pi.appendEntry(STATE_ENTRY, { active }); await reload(ctx);
  }});
  pi.registerCommand("pi-define-agents-config", { description: "Update agent definitions", handler: async (args, ctx) => {
    const previous = config;
    const next = normalize({ ...decode<Config>(args.trim()), webSearchDefaultApplied: config.webSearchDefaultApplied }); await writeConfig(next); config = next;
    try { if (!findAgent(active)) active = "default"; pi.appendEntry(STATE_ENTRY, { active }); await reload(ctx); }
    catch (error) { await writeConfig(previous); config = previous; throw error; }
  }});
}
