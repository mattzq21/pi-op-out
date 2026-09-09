import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type Agent = { name: string; model: string; effort: string; fastMode?: boolean; path_systemprompt: string; path_agentprompt: string; tools: string[]; skills: string[]; mcpServers: string[] };
type RuntimeDefaults = { model: string; effort: string };


const STATUS_KEY = "pi-define-agents";
const STATE_ENTRY = "pi-define-agents-state";
const DEFAULTS_ENV = "PI_DEFINE_AGENTS_RUNTIME_DEFAULTS";
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const DEFAULT_PROMPT_PATH = "sysprompt/default.md";
const DEFAULT_AGENT_PROMPT_PATH = "~/.piop/agents/default.md";
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
const fallbackConfig: Config = { agents: [{ name: "general", model: "", effort: "high", path_systemprompt: DEFAULT_PROMPT_PATH, path_agentprompt: DEFAULT_AGENT_PROMPT_PATH, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: [] }] };
function defaultAgent(pi: ExtensionAPI): Agent {
  const agent = structuredClone(fallbackConfig.agents[0]);
  if (desktopList(pi, "tools")?.includes("web_search")) agent.tools.push("web_search");
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

function resolvePromptPath(path: string) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(configPath), path);
}

async function ensurePromptFile(relativePath: string, contents: string) {
  const path = resolvePromptPath(relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
}

async function ensureDefaultAgentPrompt() {
  try { await readFile(resolvePromptPath(DEFAULT_AGENT_PROMPT_PATH), "utf8"); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let prompt = "";
  try { prompt = await readFile(join(homedir(), ".agents", "AGENTS.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await ensurePromptFile(DEFAULT_AGENT_PROMPT_PATH, prompt);
}

type StoredAgent = Omit<Agent, "path_systemprompt" | "path_agentprompt"> & { path_systemprompt?: string; path_agentprompt?: string; agentsMd?: string; systemPrompt?: string; developerPrompt?: string };
type StoredConfig = { agents?: StoredAgent[]; webSearchDefaultApplied?: boolean };
async function migratePrompts(stored: StoredConfig, pi: ExtensionAPI): Promise<Config> {
  const agents = [];
  for (const agent of Array.isArray(stored.agents) ? stored.agents : []) {
    if (!agent || typeof agent.name !== "string" || !agent.name.length) continue;
    let path = agent.path_systemprompt;
    if (path === undefined) {
      let prompt = typeof agent.systemPrompt === "string" ? agent.systemPrompt : undefined;
      if ("developerPrompt" in agent) {
        prompt = prompt?.trim() ? prompt : undefined;
        if (typeof agent.developerPrompt === "string" && agent.developerPrompt.trim()) prompt = `${prompt ?? DEFAULT_SYSTEM_PROMPT}\n\n${agent.developerPrompt}`;
      }
      path = DEFAULT_PROMPT_PATH;
      if (prompt !== undefined) {
        const hash = createHash("sha256").update(agent.name).update("\0").update(prompt).digest("hex");
        path = `sysprompt/${safeName(agent.name)}-${hash}.md`;
        await ensurePromptFile(path, prompt);
      }
    }
    let agentPromptPath = agent.path_agentprompt;
    if (agentPromptPath === undefined) {
      agentPromptPath = ["default", "general"].includes(agent.name) ? DEFAULT_AGENT_PROMPT_PATH : "";
      if (typeof agent.agentsMd === "string" && agent.agentsMd.trim()) {
        const hash = createHash("sha256").update(agent.name).update("\0").update(agent.agentsMd).digest("hex");
        agentPromptPath = `agentprompt/${safeName(agent.name)}-${hash}.md`;
        await ensurePromptFile(agentPromptPath, agent.agentsMd);
      }
    }
    const { systemPrompt: _inline, developerPrompt: _legacy, agentsMd: _instructions, ...profile } = agent;
    agents.push({ ...profile, path_systemprompt: path, path_agentprompt: agentPromptPath });
  }
  return normalize({ ...stored, agents }, pi);
}

function promptPath(agent: Agent): string {
  if ("systemPrompt" in agent || "developerPrompt" in agent) throw new Error(`Agent "${agent.name}" must link a system prompt file using path_systemprompt`);
  if (typeof agent.path_systemprompt !== "string" || !agent.path_systemprompt.trim()) throw new Error(`Agent "${agent.name}" requires a nonempty path_systemprompt`);
  return agent.path_systemprompt;
}

function normalize(value: Partial<Config>, pi: ExtensionAPI): Config {
  for (const agent of Array.isArray(value.agents) ? value.agents : []) if (agent && agent.fastMode !== undefined && typeof agent.fastMode !== "boolean") throw new Error(`Agent "${agent.name}" fastMode must be a boolean`);
  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => agent && typeof agent.name === "string" && agent.name.length > 0).map((agent) => ({
    name: agent.name, model: typeof agent.model === "string" ? agent.model : "", effort: typeof agent.effort === "string" ? agent.effort : fallbackConfig.agents[0].effort,
    fastMode: agent.fastMode,
    path_systemprompt: promptPath(agent), path_agentprompt: typeof agent.path_agentprompt === "string" ? agent.path_agentprompt.trim() : ["default", "general"].includes(agent.name) ? DEFAULT_AGENT_PROMPT_PATH : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => typeof item === "string") : defaultAgent(pi).tools, skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => typeof item === "string") : [], mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers.filter((item): item is string => typeof item === "string" && item !== "filesystem") : [],
  })) : [];
  if (!supplied.some((agent) => agent.name === "general")) {
    const legacy = supplied.find((agent) => agent.name === "default");
    if (legacy) legacy.name = "general";
  }
  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "general") ? unique : [defaultAgent(pi), ...unique];
  return { agents, webSearchDefaultApplied: value.webSearchDefaultApplied === true };
}

async function readConfig(pi: ExtensionAPI): Promise<Config> {
  await ensurePromptFile(DEFAULT_PROMPT_PATH, DEFAULT_SYSTEM_PROMPT);
  await ensureDefaultAgentPrompt();
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    const config = await migratePrompts(stored, pi);
    if (Array.isArray(stored.agents) && stored.agents.some((agent: StoredAgent) => agent && (agent.name === "default" && !stored.agents.some((item: StoredAgent) => item.name === "general") || "description" in agent || agent.path_systemprompt === undefined || agent.path_agentprompt === undefined || "agentsMd" in agent || "systemPrompt" in agent || "developerPrompt" in agent))) await writeConfig(config);
    return config;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Preserve profiles from older installations without changing their legacy data.
  const legacyPath = join(dirname(configPath), "..", "pi-orchestration", "config.json");
  let legacy: StoredConfig = {};
  try { legacy = JSON.parse(await readFile(legacyPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeConfig(await migratePrompts(legacy, pi), true);
  return readConfig(pi);
}
async function loadConfig(pi: ExtensionAPI): Promise<Config> {
  const config = await readConfig(pi);
  let changed = false;
  for (const agent of config.agents) {
    if (!agent.tools.some((tool) => tool === "exec_command" || tool === "apply_patch")) continue;
    agent.tools = [...new Set(agent.tools.flatMap((tool) => tool === "exec_command"
      ? ["read", "bash", "grep", "find", "ls"]
      : tool === "apply_patch" ? ["edit", "write"] : [tool]))];
    changed = true;
  }
  if (!config.webSearchDefaultApplied && desktopList(pi, "tools")?.includes("web_search")) {
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
function desktopList(pi: ExtensionAPI, name: "tools" | "skills") { const request: { settings?: { tools: string[]; skills: string[] } } = {}; pi.events.emit("piop:runtime-settings", request); return request.settings?.[name]; }
function normalizedPath(value: string) { return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }
function agentSkills(pi: ExtensionAPI, agent: Agent) { const global = desktopList(pi, "skills"); if (!global) return agent.skills; const allowed = new Set(global.map(normalizedPath)); return agent.skills.filter((skill) => allowed.has(normalizedPath(skill))); }
function agentToolError(pi: ExtensionAPI, agent: Agent) {
  const globallyAllowed = desktopList(pi, "tools"); const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const denied = [...new Set(agent.tools.filter((tool) => (globallyAllowed && !globallyAllowed.includes(tool)) || !available.has(tool)))];
  return denied.length ? `Agent "${agent.name}" cannot run because Pi does not allow its configured tool${denied.length === 1 ? "" : "s"}: ${denied.join(", ")}` : undefined;
}

function buildAgentSystemPrompt(prompt: string, options: BuildSystemPromptOptions): string {
  const sections = [prompt];
  if (options.appendSystemPrompt) sections.push(options.appendSystemPrompt);
  const readTool = (["read", "bash"] as const).find((tool) => (options.selectedTools ?? ["read", "bash", "edit", "write"]).includes(tool));
  if (readTool && options.skills?.length) sections.push(formatSkillsForPrompt(options.skills, readTool));
  return sections.join("\n\n");
}

export default async function defineAgents(pi: ExtensionAPI) {
  let config = await loadConfig(pi);
  let active = "general";
  let runtimeDefaults: RuntimeDefaults | undefined;
  let runtimeSession = "";
  let applyingAgentModel: string | undefined;
  let applyingAgentEffort: string | undefined;
  let activeToolError: string | undefined;
  let activeSystemPrompt = "";
  let activeAgentPrompt = "";
  let modelOverride: string | undefined;
  let effortOverride: string | undefined;
  let reloading = false;
  process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const currentAgent = () => findAgent(active);
  const fastModeModels = () => { const request: { models?: string[] } = {}; pi.events.emit("piop:fast-mode", request); return request.models ?? []; };
  const fastModeError = (agent: Agent, model: string | undefined) => agent.fastMode === true && (!model || !fastModeModels().includes(model)) ? `Agent "${agent.name}" cannot run because model ${model || "(unset)"} does not support fast mode` : undefined;
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active: currentAgent()?.name ?? active, config: { ...config, fastModeModels: fastModeModels() } })}`);
  const reload = async (ctx: ExtensionCommandContext) => {
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
  const activate = async (agent: Agent, ctx: ExtensionContext, connectMcp: boolean) => {
    activeSystemPrompt = "";
    activeAgentPrompt = "";
    const path = resolvePromptPath(agent.path_systemprompt);
    try { activeSystemPrompt = await readFile(path, "utf8"); }
    catch (error) { pi.setActiveTools([]); return `Agent "${agent.name}" cannot read system prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }
    if (agent.path_agentprompt) {
      const path = resolvePromptPath(agent.path_agentprompt);
      try { activeAgentPrompt = await readFile(path, "utf8"); }
      catch (error) { pi.setActiveTools([]); return `Agent "${agent.name}" cannot read agent prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const toolError = agentToolError(pi, agent); if (toolError) { pi.setActiveTools([]); return toolError; }
    const modelName = modelOverride || agent.model.trim() || runtimeDefaults?.model; const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const fastError = fastModeError(agent, agent.model.trim() || runtimeDefaults?.model || currentModel) || fastModeError(agent, modelName || currentModel);
    if (fastError) { pi.setActiveTools([]); return fastError; }
    if (modelName && modelName !== currentModel) {
      const [provider, ...parts] = modelName.split("/"); const model = ctx.modelRegistry.find(provider, parts.join("/"));
      if (!model) { pi.setActiveTools([]); return `Agent "${agent.name}" cannot run because model ${modelName} is unavailable`; }
      try { applyingAgentModel = modelName; const selected = await pi.setModel(model); if (!selected) { applyingAgentModel = undefined; pi.setActiveTools([]); return `Agent "${agent.name}" cannot authenticate model ${modelName}`; } } catch (error) { if (applyingAgentModel === modelName) applyingAgentModel = undefined; pi.setActiveTools([]); return `Agent "${agent.name}" could not select ${modelName}: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const effort = effortOverride || agent.effort.trim() || runtimeDefaults?.effort; if (effort && effort !== pi.getThinkingLevel()) { applyingAgentEffort = effort; pi.setThinkingLevel(effort as any); }
    pi.events.emit("piop:fast-mode", { apply: true, enabled: agent.fastMode, ctx });
    pi.setActiveTools([]);
    const tools = new Set(agent.tools);
    if (connectMcp && process.env.PI_DESKTOP_MCP_CONFIG) {
      const selection: { serverIds: string[]; agentName: string; sessionId: string; ready?: Promise<string[]> } = { serverIds: agent.mcpServers, agentName: agent.name, sessionId: ctx.sessionManager.getSessionId() };
      pi.events.emit("piop:mcp:select", selection);
      if (!selection.ready) return `Agent "${agent.name}" cannot run because the MCP bridge is unavailable`;
      try { for (const tool of await selection.ready) tools.add(tool); }
      catch (error) { pi.setActiveTools([]); return `Agent "${agent.name}" could not connect its MCP servers:\n${error instanceof Error ? error.message : String(error)}`; }
    } else if (connectMcp) {
      for (const info of pi.getAllTools()) if (agent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) tools.add(info.name);
    }
    pi.setActiveTools([...tools]); return undefined;
  };
  const useAgent = async (name: string, ctx: ExtensionContext, connectMcp: boolean) => {
    restore(ctx);
    const agent = findAgent(name);
    activeToolError = agent ? await activate(agent, ctx, connectMcp) : `Unknown defined agent: ${name}`;
    if (activeToolError) pi.setActiveTools([]);
    publish(ctx);
    return activeToolError;
  };
  const stopRefresh = pi.events.on("piop:agents:refresh", (value) => {
    const request = value as { ctx: ExtensionContext; ready?: Promise<void> };
    request.ready = Promise.resolve().then(() => {
      const agent = currentAgent();
      if (!agent) throw new Error(`Unknown defined agent: ${active}`);
      activeToolError = agentToolError(pi, agent);
      const mcpTools = pi.getActiveTools().filter((name) => name.startsWith("mcp_"));
      pi.setActiveTools(activeToolError ? [] : [...new Set([...agent.tools, ...mcpTools])]);
      publish(request.ctx);
    });
  });
  pi.on("session_shutdown", () => { stopRefresh(); });
  pi.on("model_select", (event) => { const model = `${event.model.provider}/${event.model.id}`; if (applyingAgentModel === model) { applyingAgentModel = undefined; return; } modelOverride = model; saveRuntimeDefaults({ model, effort: runtimeDefaults?.effort || pi.getThinkingLevel() }); });
  pi.on("thinking_level_select", (event) => { if (applyingAgentEffort === event.level) { applyingAgentEffort = undefined; return; } effortOverride = event.level; saveRuntimeDefaults({ model: runtimeDefaults?.model || "", effort: event.level }); });
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    active = "general";
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && (entry.customType === STATE_ENTRY || entry.customType === "pi-orchestration-state")) {
      const storedName = (entry.data as { active?: string })?.active;
      const name = storedName === "default" && !findAgent("default") ? "general" : storedName;
      if (name && findAgent(name)) active = name;
    }
    // Selection applies the agent's configuration; MCP startup waits for input.
    publish(ctx);
    await useAgent(active, ctx, false);
    publish(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { delete process.env.PI_DEFINE_AGENTS_ACTIVE; if (!reloading) ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("resources_discover", () => { const agent = currentAgent(); const skillPaths = agent ? agentSkills(pi, agent) : []; return skillPaths.length ? { skillPaths } : undefined; });
  pi.on("input", async (event, ctx) => {
    const error = await useAgent(active, ctx, true);
    if (error) { ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error })); ctx.ui.notify(error, "error"); return { action: "handled" }; }
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    const agent = currentAgent(); if (!agent) return;
    const base = buildAgentSystemPrompt(activeSystemPrompt, event.systemPromptOptions);
    const systemPrompt = activeAgentPrompt.trim() ? `${base}\n\n${activeAgentPrompt}` : base;
    return { systemPrompt: `${systemPrompt}\n\nCurrent working directory ${ctx.cwd.replace(/\\/g, "/")}` };
  });
  pi.registerCommand("pi-define-agents-use", { description: "Select a defined agent", handler: async (args, ctx) => {
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* Plain CLI name. */ }
    if (!findAgent(name)) throw new Error(`Unknown defined agent: ${name}`);
    restore(ctx);
    const agent = findAgent(name)!;
    const error = fastModeError(agent, agent.model.trim() || runtimeDefaults?.model);
    if (error) throw new Error(error);
    active = name; modelOverride = undefined; effortOverride = undefined;
    pi.appendEntry(STATE_ENTRY, { active }); await reload(ctx);
  }});
  pi.registerCommand("pi-define-agents-config", { description: "Update agent definitions", handler: async (args, ctx) => {
    const previous = config;
    const next = normalize({ ...decode<Config>(args.trim()), webSearchDefaultApplied: config.webSearchDefaultApplied }, pi);
    restore(ctx);
    for (const agent of next.agents) { const error = fastModeError(agent, agent.model.trim() || runtimeDefaults?.model); if (error) throw new Error(error); }
    await writeConfig(next); config = next;
    try { if (!findAgent(active)) active = "general"; pi.appendEntry(STATE_ENTRY, { active }); await reload(ctx); }
    catch (error) { await writeConfig(previous); config = previous; throw error; }
  }});
}
