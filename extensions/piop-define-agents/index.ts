import { STATE_ENTRY, DEFAULTS_ENV, DRAFT_STATE_ENV, type RuntimeDefaults, agentSchema, persistedAgentIdentity, storedRuntimeDefaults, sessionIsLocked, readAgentState } from "./state.ts";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { configPath, DEFAULT_PROMPT_PATH, DEFAULT_AGENT_PROMPT_PATH, DEFAULT_SYSTEM_PROMPT, resolvePromptPath, ensurePromptFile, snapshotPrompt, ensureDefaultAgentPrompt, writeConfig } from "./prompts.ts";
import { mcpServers } from "./mcp-config.ts";
import type { Agent, AgentSnapshot, RuntimeSettingsRequest, RequiredToolsRequest, McpToolsRequest, McpSelection } from "./contracts.ts";
import type { FastModeRequest } from "../piop-openai-fast-mode/src/types.ts";
import { agentExtensions, extensionPaths } from "./extension-loader.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type { Agent } from "./contracts.ts";

const STATUS_KEY = "pi-define-agents";

const sessionTools = ["fork_session", "create_worktree", "subagent"];

export type Config = { agents: Agent[]; webSearchDefaultApplied?: boolean; sessionToolsDefaultApplied?: boolean; subagentsDefaultApplied?: boolean; diagramistDefaultApplied?: boolean; askerAgentDefaultApplied?: boolean; terminalAgentDefaultApplied?: boolean };

const development = process.env.PIOP_STORAGE_DIRECTORY === ".piop-dev";

const fallbackConfig: Config = { agents: [{ name: "general", model: development ? "openai-codex/gpt-6-luna" : "", effort: development ? "medium" : "high", fastMode: development ? false : undefined, path_systemprompt: DEFAULT_PROMPT_PATH, path_agentprompt: DEFAULT_AGENT_PROMPT_PATH, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: [] }] };

function defaultAgent(pi: ExtensionAPI): Agent {
  const agent = structuredClone(fallbackConfig.agents[0]);

  if (desktopList(pi, "tools")?.includes("web_search")) agent.tools.push("web_search");
  agent.tools.push(...sessionTools.filter((tool) => desktopList(pi, "tools")?.includes(tool)));

  return agent;
}

async function snapshotPrompts(definition: Agent, systemPrompt: string, agentPrompt: string): Promise<AgentSnapshot> {
  return { version: 2, definition: { ...definition,
    path_systemprompt: await snapshotPrompt(systemPrompt),
    path_agentprompt: agentPrompt ? await snapshotPrompt(agentPrompt) : "",
  } };
}

type StoredAgent = Omit<Agent, "path_systemprompt" | "path_agentprompt"> & { path_systemprompt?: string; path_agentprompt?: string; agentsMd?: string; systemPrompt?: string; developerPrompt?: string };

type StoredConfig = Omit<Config, "agents"> & { agents?: StoredAgent[] };

async function migrateSystemPrompt(agent: StoredAgent) {
  let path = agent.path_systemprompt;

  if (path === undefined) {
    let prompt = Check(Type.String(), agent.systemPrompt) ? agent.systemPrompt : undefined;

    if ("developerPrompt" in agent) {
      prompt = prompt?.trim() ? prompt : undefined;

      if (Check(Type.String(), agent.developerPrompt) && agent.developerPrompt.trim()) prompt = `${prompt ?? DEFAULT_SYSTEM_PROMPT}\n\n${agent.developerPrompt}`;
    }

    path = DEFAULT_PROMPT_PATH;

    if (prompt !== undefined) {
      const hash = createHash("sha256").update(agent.name).update("\0").update(prompt).digest("hex");
      path = `sysprompt/${safeName(agent.name)}-${hash}.md`;
      await ensurePromptFile(path, prompt);
    }
  }

  return path;
}

async function migrateAgentPrompt(agent: StoredAgent) {
  let agentPromptPath = agent.path_agentprompt;

  if (agentPromptPath === undefined) {
    agentPromptPath = ["default", "general"].includes(agent.name) ? DEFAULT_AGENT_PROMPT_PATH : "";

    if (Check(Type.String(), agent.agentsMd) && agent.agentsMd.trim()) {
      const hash = createHash("sha256").update(agent.name).update("\0").update(agent.agentsMd).digest("hex");
      agentPromptPath = `agentprompt/${safeName(agent.name)}-${hash}.md`;
      await ensurePromptFile(agentPromptPath, agent.agentsMd);
    }
  }

  return agentPromptPath;
}

async function migratePrompts(stored: StoredConfig, pi: ExtensionAPI): Promise<Config> {
  const agents = [];

  for (const agent of Array.isArray(stored.agents) ? stored.agents : []) {
    if (!Check(Type.Object({ name: Type.String({ minLength: 1 }) }), agent)) continue;
    const path = await migrateSystemPrompt(agent);
    const agentPromptPath = await migrateAgentPrompt(agent);
    const { systemPrompt: _inline, developerPrompt: _legacy, agentsMd: _instructions, ...profile } = agent;
    agents.push({ ...profile, path_systemprompt: path, path_agentprompt: agentPromptPath });
  }

  return normalize({ ...stored, agents }, pi);
}

function promptPath(agent: Agent): string {
  if ("systemPrompt" in agent || "developerPrompt" in agent) throw new Error(`Agent "${agent.name}" must link a system prompt file using path_systemprompt`);

  if (!Check(Type.String({ pattern: "\\S" }), agent.path_systemprompt)) throw new Error(`Agent "${agent.name}" requires a nonempty path_systemprompt`);

  return agent.path_systemprompt;
}

function normalize(value: Partial<Config>, pi: ExtensionAPI): Config {
  for (const agent of Array.isArray(value.agents) ? value.agents : []) if (agent && agent.fastMode !== undefined && !Check(Type.Boolean(), agent.fastMode)) throw new Error(`Agent "${agent.name}" fastMode must be a boolean`);

  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => Check(Type.Object({ name: Type.String({ minLength: 1 }) }), agent)).map((agent) => ({
    name: agent.name, model: Check(Type.String(), agent.model) ? agent.model : "", effort: Check(Type.String(), agent.effort) ? agent.effort : fallbackConfig.agents[0].effort,
    fastMode: agent.fastMode, extensions: extensionPaths(agent.extensions),
    path_systemprompt: promptPath(agent), path_agentprompt: Check(Type.String(), agent.path_agentprompt) ? agent.path_agentprompt.trim() : ["default", "general"].includes(agent.name) ? DEFAULT_AGENT_PROMPT_PATH : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => Check(Type.String(), item)).flatMap(item => item === "goal" ? ["get_goal", "create_goal", "update_goal"] : [item]) : defaultAgent(pi).tools, skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => Check(Type.String(), item)) : [], mcpServers: mcpServers(agent.mcpServers),
  })) : [];

  if (!supplied.some((agent) => agent.name === "general")) {
    const legacy = supplied.find((agent) => agent.name === "default");

    if (legacy) legacy.name = "general";
  }

  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "general") ? unique : [defaultAgent(pi), ...unique];

  return { agents, webSearchDefaultApplied: value.webSearchDefaultApplied === true, sessionToolsDefaultApplied: value.sessionToolsDefaultApplied === true, subagentsDefaultApplied: value.subagentsDefaultApplied === true, diagramistDefaultApplied: value.diagramistDefaultApplied === true, askerAgentDefaultApplied: value.askerAgentDefaultApplied === true, terminalAgentDefaultApplied: value.terminalAgentDefaultApplied === true };
}

async function readConfig(pi: ExtensionAPI): Promise<Config> {
  await ensurePromptFile(DEFAULT_PROMPT_PATH, DEFAULT_SYSTEM_PROMPT);
  await ensureDefaultAgentPrompt();

  try {
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    const config = await migratePrompts(stored, pi);

    if (Array.isArray(stored.agents) && stored.agents.some((agent: StoredAgent) => agent && (agent.name === "default" && !stored.agents.some((item: StoredAgent) => item?.name === "general") || "description" in agent || agent.path_systemprompt === undefined || agent.path_agentprompt === undefined || "agentsMd" in agent || "systemPrompt" in agent || "developerPrompt" in agent))) await writeConfig(config);

    return config;
  }
  catch (error) { if (!Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) throw error; }

  await writeConfig(normalize({}, pi), true);

  return readConfig(pi);
}

function migrateSessionTools(config: Config, pi: ExtensionAPI) {
  const available = sessionTools.filter((tool) => desktopList(pi, "tools")?.includes(tool));

  if (config.sessionToolsDefaultApplied || !available.length) return false;

  for (const agent of config.agents) agent.tools = [...new Set([...agent.tools, ...available])];
  config.sessionToolsDefaultApplied = true;

  return true;
}

function migrateSubagents(config: Config, pi: ExtensionAPI) {
  if (!config.subagentsDefaultApplied && desktopList(pi, "tools")?.includes("subagent")) {
    for (const agent of config.agents) if (!agent.tools.includes("subagent")) agent.tools.push("subagent");
    config.subagentsDefaultApplied = true;

    return true;
  }

  return false;
}

function migrateUserInput(config: Config, pi: ExtensionAPI) {
  if (config.askerAgentDefaultApplied || !desktopList(pi, "tools")?.includes("request_user_input")) return false;
  const general = config.agents.find((agent) => agent.name === "general");

  if (general && !config.agents.some(agent => agent.name === "asker-agent")) {
    const asker = structuredClone(general);
    asker.name = "asker-agent";
    asker.tools = [...new Set([...asker.tools, "request_user_input"])];
    config.agents.push(asker);
  }

  for (const agent of config.agents) {
    agent.tools = [...new Set(agent.tools.flatMap(tool => {
      if (tool !== "request_user_input_async" && tool !== "request_user_input") return [tool];

      return agent.name === "general" ? [] : ["request_user_input"];
    }))];
  }

  config.askerAgentDefaultApplied = true;

  return true;
}

function migrateTerminalAgent(config: Config, pi: ExtensionAPI) {
  if (config.terminalAgentDefaultApplied || !desktopList(pi, "tools")?.includes("lookup_terminals")) return false;

  if (!config.agents.some(agent => agent.name === "terminal-agent")) {
    const agent = structuredClone(config.agents.find(agent => agent.name === "general") ?? defaultAgent(pi));
    agent.name = "terminal-agent";
    agent.tools = [...new Set([...agent.tools, "lookup_terminals"])];
    config.agents.push(agent);
  }

  for (const agent of config.agents) if (agent.name !== "terminal-agent") agent.tools = agent.tools.filter(tool => tool !== "lookup_terminals");
  config.terminalAgentDefaultApplied = true;

  return true;
}

function migrateQuestionSnapshot(stored: AgentSnapshot | undefined) {
  if (stored?.version !== 1 && stored?.version !== 2) return undefined;

  if (!stored.definition || !Array.isArray(stored.definition.tools)) return undefined;
  const snapshot = structuredClone(stored);
  snapshot.definition.tools = [...new Set(snapshot.definition.tools.map((tool) => tool === "request_user_input_async" ? "request_user_input" : tool))];

  return snapshot;
}

async function migrateDiagramist(config: Config, pi: ExtensionAPI) {
  if (config.diagramistDefaultApplied) return false;

  if (!config.agents.some(agent => agent.name === "diagramist")) {
    const path = "sysprompt/diagramist.md";
    await ensurePromptFile(path, `${DEFAULT_SYSTEM_PROMPT}\n\nYou are diagramist. Explain systems, code, and data through clear, accurate diagrams. Inspect the relevant sources before depicting relationships, and distinguish observed behavior from proposed designs.`);
    config.agents.push({ ...defaultAgent(pi), name: "diagramist", path_systemprompt: path, extensions: ["../piop-diagrams.ts"] });
  }

  config.diagramistDefaultApplied = true;

  return true;
}

async function loadConfig(pi: ExtensionAPI): Promise<Config> {
  const config = await readConfig(pi);
  let changed = [migrateSessionTools(config, pi), migrateSubagents(config, pi), await migrateDiagramist(config, pi), migrateUserInput(config, pi), migrateTerminalAgent(config, pi)].some(Boolean);

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

  const retainedAgents = config.agents.filter(agent => agent.name !== "voice-orchestrator");

  if (retainedAgents.length !== config.agents.length) { config.agents = retainedAgents; changed = true; }

  if (changed) await writeConfig(config);

  return config;
}

function encode<T>(value: T) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

function decode<S extends TSchema>(schema: S, value: string): Static<S> {
  const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

  if (!Check(schema, decoded)) throw new Error("Invalid encoded agent configuration");

  return decoded;
}

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"; }

function desktopList(pi: ExtensionAPI, name: "tools" | "skills" | "explicitOnlySkills") { const request: RuntimeSettingsRequest = {}; pi.events.emit("piop:runtime-settings", request);

return request.settings?.[name]; }

function normalizedPath(value: string) { return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }

function agentSkills(pi: ExtensionAPI, agent: Agent) { const global = desktopList(pi, "skills");

if (!global) return agent.skills; const allowed = new Set(global.map(normalizedPath));

return agent.skills.filter((skill) => allowed.has(normalizedPath(skill))); }

function agentToolError(pi: ExtensionAPI, agent: Agent, extensionTools: string[] = []) {
  const globallyAllowed = desktopList(pi, "tools"); const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const denied = [...new Set(agent.tools.filter((tool) => (globallyAllowed && !globallyAllowed.includes(tool) && !extensionTools.includes(tool)) || !available.has(tool)))];

  return denied.length ? `Agent "${agent.name}" cannot run because Pi does not allow its configured tool${denied.length === 1 ? "" : "s"}: ${denied.join(", ")}` : undefined;
}

function configureAgentSystemPrompt(prompt: string, agentPrompt: string, options: BuildSystemPromptOptions, explicitOnlySkills: string[] = []) {
  delete options.forceSystemPrompt;
  const instructions = [options.appendSystemPrompt, agentPrompt.trim() ? agentPrompt : undefined].filter(Boolean).join("\n\n");
  options.customPrompt = prompt || " ";
  options.sections = { ...options.sections, instructions };
  options.contextFiles = [];
  options.appendSystemPrompt = "";
  const explicit = new Set(explicitOnlySkills.map(normalizedPath));
  options.skills = options.skills?.map((skill) => explicit.has(normalizedPath(skill.filePath)) || explicit.has(normalizedPath(skill.baseDir)) ? { ...skill, disableModelInvocation: true } : skill);
}

export default async function defineAgents(pi: ExtensionAPI) {
  const extensions = agentExtensions(pi, dirname(configPath));
  let config = await loadConfig(pi);
  let active = "general";
  let snapshot: AgentSnapshot | undefined;
  let savedState: string | undefined;
  let locked = false;
  let runtimeDefaults: RuntimeDefaults | undefined;
  let runtimeSession = "";
  let applyingAgentModel: string | undefined;
  let applyingAgentEffort: string | undefined;
  let activeToolError: string | undefined;
  let activeSystemPrompt = "";
  let activeAgentPrompt = "";
  let modelOverride: string | undefined;
  let fastModeOverride: boolean | undefined;
  let effortOverride: string | undefined;
  let reloading = false;
  process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const currentAgent = () => snapshot?.definition ?? findAgent(active);

  const currentMcpTools = () => { const request: McpToolsRequest = {}; pi.events.emit("piop:mcp:tools", request);

  return request.tools ?? []; };

  pi.on("tool_call", (event, ctx) => {
    const agent = currentAgent();
    const required: RequiredToolsRequest = { ctx, tools: [] }; pi.events.emit("piop:required-tools", required);
    const allowed = agent && !activeToolError && new Set([...agent.tools, ...extensions.tools(), ...currentMcpTools(), ...required.tools]);

    if (!allowed || !allowed.has(event.toolName) || (event.toolName === "lookup_terminals" && agent?.name !== "terminal-agent")) {
      return { block: true, reason: `Tool ${event.toolName} is not allowed for agent ${agent?.name ?? active}` };
    }
  });

  const stopSubagentProfiles = pi.events.on("piop:agents:subagent", (request) => {
    const agent = request.agent ? findAgent(request.agent) : currentAgent();

    if (!agent) { request.error = "Choose a configured agent profile";

    return; }

    request.state = request.agent
      ? { active: agent.name, locked: false }
      : { active: agent.name, locked: false, snapshot: snapshot && structuredClone(snapshot), modelOverride: modelOverride || agent.model || runtimeDefaults?.model, effortOverride: pi.getThinkingLevel(), fastModeOverride };
  });

  const restoredAgentName = (name: string | undefined) => !name || (name === "default" && !findAgent("default")) ? "general" : name;

  const currentSkillPaths = () => {
    const agent = currentAgent();

    return [...new Set(agent ? agentSkills(pi, agent).map(normalizedPath) : [])].sort();
  };

  const fastModeModels = () => { const request: FastModeRequest = {}; pi.events.emit("piop:fast-mode", request);

  return request.models ?? []; };

  const fastModeError = (agent: Agent, model: string | undefined) => agent.fastMode === true && (!model || !fastModeModels().includes(model)) ? `Agent "${agent.name}" cannot run because model ${model || "(unset)"} does not support fast mode` : undefined;

  const refreshFastMode = async (ctx: ExtensionContext) => {
    const request: FastModeRequest = { ctx, refresh: true };
    pi.events.emit("piop:fast-mode", request);
    await request.ready;
  };

  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active: currentAgent()?.name ?? active, locked, saved: !!snapshot, unavailable: !currentAgent(), config: { ...config, fastModeModels: fastModeModels() } })}`);

  const saveState = (submit = false) => {
    const state = { active, modelOverride, effortOverride, fastModeOverride: fastModeOverride ?? null, snapshot };

    if (!submit) {
      process.env[DRAFT_STATE_ENV] = JSON.stringify({ session: runtimeSession, identity: savedState, state });

      return;
    }

    delete process.env[DRAFT_STATE_ENV];
    const serialized = persistedAgentIdentity(state);

    if (serialized === savedState) return;
    pi.appendEntry(STATE_ENTRY, state);
    savedState = serialized;
  };

  const reload = async (ctx: ExtensionCommandContext) => {
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
    runtimeDefaults = storedRuntimeDefaults(session);

    if (!runtimeDefaults) saveRuntimeDefaults({ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", effort: pi.getThinkingLevel() });
  };

  const snapshotDefinition = (agent: Agent) => structuredClone({ ...agent, model: agent.model.trim() || runtimeDefaults?.model || "", effort: agent.effort.trim() || runtimeDefaults?.effort || "" });

  const persistAgentSnapshot = async (agent: Agent, persist: boolean) => {
    if (snapshot?.version !== 2) snapshot = await snapshotPrompts(snapshotDefinition(agent), activeSystemPrompt, activeAgentPrompt);

    if (persist) saveState();
  };

  const prepareAgentPrompts = async (agent: Agent, persistSnapshot: boolean) => {
    activeSystemPrompt = "";
    activeAgentPrompt = "";

    if (snapshot?.version === 1) {
      activeSystemPrompt = snapshot.systemPrompt;
      activeAgentPrompt = snapshot.agentPrompt;
    } else {
      const path = resolvePromptPath(agent.path_systemprompt);

      try { activeSystemPrompt = await readFile(path, "utf8"); }
      catch (error) { pi.setActiveTools([]);

      return `Agent "${agent.name}" cannot read system prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }

      if (agent.path_agentprompt) {
        const path = resolvePromptPath(agent.path_agentprompt);

        try { activeAgentPrompt = await readFile(path, "utf8"); }
        catch (error) { pi.setActiveTools([]);

        return `Agent "${agent.name}" cannot read agent prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }
      }
    }

    await persistAgentSnapshot(agent, persistSnapshot);

  };

  const validateFastMode = (agent: Agent, modelName: string | undefined, currentModel: string | undefined) => fastModeError(agent, agent.model.trim() || runtimeDefaults?.model || currentModel) || fastModeError(agent, modelName || currentModel);

  const selectAgentModel = async (agent: Agent, ctx: ExtensionContext, modelName: string) => {
    const [provider, ...parts] = modelName.split("/"); const model = ctx.modelRegistry.find(provider, parts.join("/"));

    if (!model) { pi.setActiveTools([]);

    return `Agent "${agent.name}" cannot run because model ${modelName} is unavailable`; }

    try {
      applyingAgentModel = modelName;
      const selected = await pi.setModel(model);

      if (!selected) { applyingAgentModel = undefined; pi.setActiveTools([]);

      return `Agent "${agent.name}" cannot authenticate model ${modelName}`; }
    } catch (error) {
      if (applyingAgentModel === modelName) applyingAgentModel = undefined;
      pi.setActiveTools([]);

      return `Agent "${agent.name}" could not select ${modelName}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const configureAgentModel = async (agent: Agent, ctx: ExtensionContext) => {
    await refreshFastMode(ctx);
    const modelName = modelOverride || agent.model.trim() || runtimeDefaults?.model; const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const fastError = validateFastMode(agent, modelName, currentModel);

    if (fastError) { pi.setActiveTools([]);

    return fastError; }

    if (modelName && modelName !== currentModel) {
      return selectAgentModel(agent, ctx, modelName);
    }

  };

  const configureAgentEffort = (agent: Agent) => {
    const effort = effortOverride || agent.effort.trim() || runtimeDefaults?.effort;

    if (effort && effort !== pi.getThinkingLevel()) {
      const levels: Array<Parameters<ExtensionAPI["setThinkingLevel"]>[0]> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const level = levels.find(value => value === effort);

      if (!level) throw new Error(`Unknown thinking level: ${effort}`);
      applyingAgentEffort = level; pi.setThinkingLevel(level);
    }

  };

  const connectAgentMcp = async (agent: Agent, ctx: ExtensionContext, connectMcp: boolean, tools: Set<string>) => {
    if (connectMcp) {
      const selection: McpSelection = { servers: mcpServers(agent.mcpServers), agentName: agent.name, sessionId: ctx.sessionManager.getSessionId() };
      pi.events.emit("piop:mcp:select", selection);

      if (!selection.ready && selection.servers.some((server) => server.enabled)) return `Agent "${agent.name}" cannot run because the MCP bridge is unavailable`;

      try { for (const tool of await (selection.ready ?? Promise.resolve([]))) tools.add(tool); }
      catch (error) { pi.setActiveTools([]);

      return `Agent "${agent.name}" could not connect its MCP servers:\n${error instanceof Error ? error.message : String(error)}`; }
    }

  };

  const effectiveAgentFastMode = (agent: Agent) => fastModeOverride ?? agent.fastMode;

  const activate = async (agent: Agent, ctx: ExtensionContext, connectMcp: boolean, persistSnapshot: boolean, applyFastMode: boolean | "restore") => {
    const promptError = await prepareAgentPrompts(agent, persistSnapshot);

    if (promptError) return promptError;

    try { await extensions.activate(await extensions.prepare(extensionPaths(agent.extensions)), ctx); }
    catch (error) { pi.setActiveTools([]);

    return `Agent "${agent.name}" could not load its piop extensions:\n${error instanceof Error ? error.message : String(error)}`; }

    const toolError = agentToolError(pi, agent, extensions.tools());

    if (toolError) { pi.setActiveTools([]);

    return toolError; }

    const modelError = await configureAgentModel(agent, ctx);

    if (modelError) return modelError;
    configureAgentEffort(agent);

    if (applyFastMode) pi.events.emit("piop:fast-mode", { apply: true, enabled: effectiveAgentFastMode(agent), restore: applyFastMode === "restore", ctx });
    pi.setActiveTools([]);
    const tools = new Set([...agent.tools, ...extensions.tools()]);
    const mcpError = await connectAgentMcp(agent, ctx, connectMcp, tools);

    if (mcpError) return mcpError;

    if (agent.name !== "terminal-agent") tools.delete("lookup_terminals");
    const required: RequiredToolsRequest = { ctx, tools: [] }; pi.events.emit("piop:required-tools", required);

    for (const tool of required.tools) tools.add(tool);
    pi.setActiveTools([...tools]);

    return undefined;
  };

  const useAgent = async (name: string, ctx: ExtensionContext, connectMcp: boolean, persistSnapshot = true, applyFastMode: boolean | "restore" = true) => {
    restore(ctx);
    const agent = currentAgent();
    activeToolError = agent ? await activate(agent, ctx, connectMcp, persistSnapshot, applyFastMode) : `Agent unavailable: "${name}". Select a replacement or general to continue.`;

    if (activeToolError) pi.setActiveTools([]);
    publish(ctx);

    return activeToolError;
  };

  const stopRefresh = pi.events.on("piop:agents:refresh", (request) => {
    request.ready = Promise.resolve().then(() => {
      const agent = currentAgent();

      if (!agent) { pi.setActiveTools([]); publish(request.ctx);

      return; }

      activeToolError = agentToolError(pi, agent, extensions.tools());
      const mcpTools = currentMcpTools();
      const required: RequiredToolsRequest = { ctx: request.ctx, tools: [] }; pi.events.emit("piop:required-tools", required);
      pi.setActiveTools(activeToolError ? [] : [...new Set([...agent.tools, ...extensions.tools(), ...mcpTools, ...required.tools])]);
      publish(request.ctx);
    });
  });

  const stopFastModeChanges = pi.events.on("piop:fast-mode-changed", ({ enabled }) => {

    if (enabled === undefined || enabled === fastModeOverride) return;
    fastModeOverride = enabled;
    saveState();
  });

  const stopFastModelChanges = pi.events.on("piop:fast-mode-models-changed", ({ ctx }) => publish(ctx));
  pi.on("session_shutdown", () => { stopSubagentProfiles(); stopRefresh(); stopFastModeChanges(); stopFastModelChanges(); extensions.stop(); });
  pi.on("model_select", (event) => { const model = `${event.model.provider}/${event.model.id}`;

  if (applyingAgentModel === model) { applyingAgentModel = undefined;

  return; }

  modelOverride = model; saveState(); saveRuntimeDefaults({ model, effort: runtimeDefaults?.effort || pi.getThinkingLevel() }); });
  pi.on("thinking_level_select", (event) => { if (applyingAgentEffort === event.level) { applyingAgentEffort = undefined;

  return; }

  effortOverride = event.level; saveState(); saveRuntimeDefaults({ model: runtimeDefaults?.model || "", effort: event.level }); });

  const restoreSession = async (ctx: ExtensionContext) => {
    restore(ctx);
    const branch = ctx.sessionManager.getBranch();
    const { states, stored, identity, fastMode } = readAgentState(branch, runtimeSession);
    savedState = identity;
    snapshot = migrateQuestionSnapshot(stored?.snapshot);
    active = snapshot?.definition.name ?? restoredAgentName(stored?.active);

    if (active === "voice-orchestrator") { active = "general"; snapshot = undefined; }

    locked = sessionIsLocked(states, branch);
    modelOverride = stored?.modelOverride;
    fastModeOverride = fastMode;
    effortOverride = stored?.effortOverride;
    publish(ctx);
    const error = await useAgent(active, ctx, false, true, "restore");

    if (error) ctx.ui.notify(error, "warning");
    publish(ctx);
    pi.events.emit("piop:agents:ready", { ctx });
  };

  pi.on("session_start", (_event, ctx) => restoreSession(ctx));
  pi.on("session_tree", (_event, ctx) => restoreSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => { delete process.env.PI_DEFINE_AGENTS_ACTIVE;

  if (!reloading) ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("resources_discover", () => { const agent = currentAgent(); const skillPaths = agent ? agentSkills(pi, agent) : [];

  return skillPaths.length ? { skillPaths } : undefined; });
  pi.on("input", async (event, ctx) => {
    if (!locked) { locked = true; publish(ctx); }

    const error = await useAgent(active, ctx, true, true, false);

    if (error) { ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error })); ctx.ui.notify(error, "error");

    return { action: "handled" }; }

    saveState(true);

    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    const agent = currentAgent();

    if (!agent) return;
    configureAgentSystemPrompt(activeSystemPrompt, activeAgentPrompt, event.systemPromptOptions, desktopList(pi, "explicitOnlySkills"));
  });
  pi.registerCommand("pi-define-agents-use", {
    description: "Select a defined agent", handler: async (args, ctx) => {
      const argument = args.trim(); let name = argument;

      try { name = decode(Type.String(), argument); } catch { }

      if (!ctx.isIdle()) throw new Error("Wait for the current response before changing agents");
      await selectAgent(name, ctx);
    }
});

  const selectAgent = async (name: string, ctx: ExtensionCommandContext) => {
    if (locked && currentAgent()) {
      if (name === active) return;
      throw new Error("This conversation's agent is fixed. Start a new conversation to use another agent.");
    }

    const agent = findAgent(name);

    if (!agent) throw new Error(`Unknown defined agent: ${name}`);
    restore(ctx);
    await refreshFastMode(ctx);
    const error = fastModeError(agent, agent.model.trim() || runtimeDefaults?.model);

    if (error) throw new Error(error);
    await extensions.prepare(extensionPaths(agent.extensions));
    const previousActive = active;
    const previousSnapshot = snapshot;
    const previousModel = modelOverride;
    const previousFastMode = fastModeOverride;
    const previousEffort = effortOverride;
    const previousSkills = currentSkillPaths();
    active = name; snapshot = undefined; modelOverride = undefined; effortOverride = undefined; fastModeOverride = undefined;
    const skillsChanged = JSON.stringify(previousSkills) !== JSON.stringify(currentSkillPaths());
    const activationError = await useAgent(active, ctx, false, false);

    if (activationError) { active = previousActive; snapshot = previousSnapshot; modelOverride = previousModel; effortOverride = previousEffort; fastModeOverride = previousFastMode; await useAgent(active, ctx, false, false); throw new Error(activationError); }

    saveState();

    if (skillsChanged) return reload(ctx);
  };

  pi.registerCommand("pi-define-agents-config", {
    description: "Update agent definitions", handler: async (args, ctx) => {
      const supplied = decode(Type.Object({ agents: Type.Optional(Type.Array(agentSchema)) }), args.trim());
      const next = normalize({ ...supplied, webSearchDefaultApplied: config.webSearchDefaultApplied, sessionToolsDefaultApplied: config.sessionToolsDefaultApplied, subagentsDefaultApplied: config.subagentsDefaultApplied, diagramistDefaultApplied: config.diagramistDefaultApplied, askerAgentDefaultApplied: config.askerAgentDefaultApplied, terminalAgentDefaultApplied: config.terminalAgentDefaultApplied }, pi);
      await writeConfig(next);
      config = next;
      publish(ctx);
    }
});
}
