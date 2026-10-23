import { readAgentResources, resourcePath, type AgentResources } from "./resources.ts";
import { STATE_ENTRY, DEFAULTS_ENV, DRAFT_STATE_ENV, type RuntimeDefaults, agentSchema, agentThinkingLevels, persistedAgentIdentity, storedRuntimeDefaults, sessionIsLocked, readAgentState, subagentLimit, registerSubagentLimits, agentFlag, agentAccess, agentDescription, startRefusal } from "./state.ts";
import { Type } from "typebox";
import { Check, Errors, Parse } from "typebox/value";
import { configPath, DEFAULT_PROMPT_PATH, DEFAULT_SYSTEM_PROMPT, resolvePromptPath, ensurePromptFile, snapshotPrompts, ensureDefaultAgentPrompt, readPrompt, readConfigDocument, writeConfig } from "./prompts.ts";
import { mcpServersSchema } from "./mcp-schema.ts";
import { fallbackConfig, copySnapshot, selectedProfileState } from "./profiles.ts";
import { mcpServers, type McpServers, type LegacyMcpServer } from "./mcp-config.ts";
import type { Agent, AgentSnapshot, RequiredToolsRequest, McpToolsRequest, McpSelection, SessionAgentState } from "./contracts.ts";
import { fastModeSession, fastModelProblem, hostFastModels } from "./fast-models.ts";
import { agentExtensions, extensionPaths } from "./extension-loader.ts";
import { capRangeError } from "../piop-context-window-cap/interface.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type { Agent } from "./contracts.ts";

const STATUS_KEY = "pi-define-agents";

const sessionTools = ["spawn_subagents"];

export type Config = { revision?: string; agents: Agent[]; webSearchDefaultApplied?: boolean; sessionToolsDefaultApplied?: boolean; subagentsDefaultApplied?: boolean; workhorseDefaultApplied?: boolean; };

type ConfigRuntime = { enabledTools?: readonly string[] };

export type ConfigStorage = { ensurePromptFile: typeof ensurePromptFile; writeConfig: typeof writeConfig };

function generalAgent(pi: ConfigRuntime): Agent {
  const agent = structuredClone(fallbackConfig.agents[0]);

  if (enabledTools(pi)?.includes("web_search")) agent.tools.push("web_search");
  agent.tools.push(...sessionTools.filter((tool) => enabledTools(pi)?.includes(tool)));

  return agent;
}

type StoredAgent = Omit<Agent, "path_systemprompt" | "path_agent_prompt" | "mcpServers"> & { mcpServers?: McpServers | LegacyMcpServer[]; path_systemprompt?: string; path_agent_prompt?: string; path_agentprompt?: string; ignoreGeneralAgentsMd?: boolean; agentsMd?: string; systemPrompt?: string; developerPrompt?: string };

type StoredConfig = Omit<Config, "agents"> & { agents?: StoredAgent[] };

async function migrateSystemPrompt(agent: StoredAgent, storage: ConfigStorage) {
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
      await storage.ensurePromptFile(path, prompt);
    }
  }

  return path;
}

async function migrateAgentPrompt(agent: StoredAgent, storage: ConfigStorage) {
  let agentPromptPath = agent.path_agent_prompt ?? agent.path_agentprompt;

  if (agentPromptPath === undefined) {
    agentPromptPath = "";

    if (Check(Type.String(), agent.agentsMd) && agent.agentsMd.trim()) {
      const hash = createHash("sha256").update(agent.name).update("\0").update(agent.agentsMd).digest("hex");
      agentPromptPath = `agentprompt/${safeName(agent.name)}-${hash}.md`;
      await storage.ensurePromptFile(agentPromptPath, agent.agentsMd);
    }
  }

  return agentPromptPath;
}

async function migratePrompts(stored: StoredConfig, pi: ConfigRuntime, storage: ConfigStorage): Promise<Config> {
  const agents = [];

  for (const agent of Array.isArray(stored.agents) ? stored.agents : []) {
    if (!Check(Type.Object({ name: Type.String({ minLength: 1 }) }), agent)) continue;
    const path = await migrateSystemPrompt(agent, storage);
    const agentPromptPath = await migrateAgentPrompt(agent, storage);
    const { systemPrompt: _inline, developerPrompt: _legacy, agentsMd: _instructions, path_agentprompt: _oldPromptPath, ignoreGeneralAgentsMd: _oldIgnore, ...profile } = agent;
    agents.push({ ...profile, path_systemprompt: path, path_agent_prompt: agentPromptPath });
  }

  return normalize({ ...stored, agents }, pi);
}

function promptPath(agent: StoredAgent): string {
  if ("systemPrompt" in agent || "developerPrompt" in agent) throw new Error(`Agent "${agent.name}" must link a system prompt file using path_systemprompt`);

  if (!Check(Type.String({ pattern: "\\S" }), agent.path_systemprompt)) throw new Error(`Agent "${agent.name}" requires a nonempty path_systemprompt`);

  return agent.path_systemprompt;
}

function normalize(value: Omit<Partial<Config>, "agents"> & { agents?: StoredAgent[] }, pi: ConfigRuntime): Config {
  for (const agent of Array.isArray(value.agents) ? value.agents : []) {
    if (agent && agent.fastMode !== undefined && !Check(Type.Boolean(), agent.fastMode)) throw new Error(`Agent "${agent.name}" fastMode must be a boolean`);

    if (agent && agent.isDefault !== undefined && !Check(Type.Boolean(), agent.isDefault)) throw new Error(`Agent "${agent.name}" isDefault must be a boolean`);
    const capError = agent?.contextWindowCap === undefined || agent.contextWindowCap === null ? undefined : typeof agent.contextWindowCap === "number" ? capRangeError(agent.contextWindowCap, `Agent "${agent.name}" context cap`) : `Agent "${agent.name}" context cap must be a number or null`;

    if (capError) throw new Error(capError);
  }

  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => Check(Type.Object({ name: Type.String({ minLength: 1 }) }), agent)).map((agent) => ({
    name: agent.name, ...(agent.isDefault === true ? { isDefault: true } : {}), description: agentDescription(agent.description, agent.name), model: Check(Type.String(), agent.model) ? agent.model : "", effort: Check(Type.String(), agent.effort) ? agent.effort : fallbackConfig.agents[0].effort,
    fastMode: agent.fastMode, contextWindowCap: agent.contextWindowCap, codemode: agent.codemode, extensions: extensionPaths(agent.extensions),
    max_subagents: subagentLimit(agent.max_subagents, agent.name, "max_subagents"), max_sub_subagents: subagentLimit(agent.max_sub_subagents, agent.name, "max_sub_subagents"),
    allow_as_subagent: agentFlag(agent.allow_as_subagent, agent.name, "allow_as_subagent"), allow_as_peer: agentFlag(agent.allow_as_peer, agent.name, "allow_as_peer"),
    allowed_subagents: agentAccess(agent.allowed_subagents, agent.name, "allowed_subagents"), allowed_peers: agentAccess(agent.allowed_peers, agent.name, "allowed_peers"),
    path_systemprompt: promptPath(agent), path_agent_prompt: Check(Type.String(), agent.path_agent_prompt) ? agent.path_agent_prompt.trim() : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => Check(Type.String(), item)) : generalAgent(pi).tools, skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => Check(Type.String(), item)) : [], mcpServers: mcpServers(agent.mcpServers),
  })) : [];

  if (!supplied.some((agent) => agent.name === "general")) {
    const legacy = supplied.find((agent) => agent.name === "default");

    if (legacy) legacy.name = "general";
  }

  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "general") ? unique : [generalAgent(pi), ...unique];
  const defaults = agents.filter(agent => agent.isDefault);

  if (defaults.length > 1) throw new Error(`Only one agent can be the default. Default agents: ${defaults.map(agent => agent.name).join(", ")}`);

  if (!defaults.length) required(agents.find(agent => agent.name === "general")).isDefault = true;

  return { revision: value.revision, agents, webSearchDefaultApplied: value.webSearchDefaultApplied === true, sessionToolsDefaultApplied: value.sessionToolsDefaultApplied === true, subagentsDefaultApplied: value.subagentsDefaultApplied === true, workhorseDefaultApplied: value.workhorseDefaultApplied === true };
}

async function readConfig(pi: ConfigRuntime, supplied: StoredConfig | undefined, initialize: boolean, storage: ConfigStorage): Promise<Config> {
  if (initialize) {
    await ensurePromptFile(DEFAULT_PROMPT_PATH, DEFAULT_SYSTEM_PROMPT);
    await ensureDefaultAgentPrompt();
  }

  try {
    const stored = supplied ?? await readConfigDocument();
    const config = await migratePrompts(stored, pi, storage);

    if (Array.isArray(stored.agents) && stored.agents.some((agent: StoredAgent) => agent && (Array.isArray(agent.mcpServers) || agent.name === "default" && !stored.agents.some((item: StoredAgent) => item?.name === "general") || agent.path_systemprompt === undefined || agent.path_agent_prompt === undefined || ["path_agentprompt", "ignoreGeneralAgentsMd", "agentsMd", "systemPrompt", "developerPrompt"].some(key => key in agent)))) await storage.writeConfig(config);

    return config;
  }
  catch (error) { if (!initialize || !Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) throw error; }

  await storage.writeConfig(normalize({}, pi), true);

  return readConfig(pi, undefined, initialize, storage);
}

function migrateSessionTools(config: Config, pi: ConfigRuntime) {
  const available = sessionTools.filter((tool) => enabledTools(pi)?.includes(tool));

  if (config.sessionToolsDefaultApplied || !available.length) return false;

  for (const agent of config.agents) agent.tools = [...new Set([...agent.tools, ...available])];
  config.sessionToolsDefaultApplied = true;

  return true;
}

function migrateSubagents(config: Config, pi: ConfigRuntime) {
  if (!config.subagentsDefaultApplied && enabledTools(pi)?.includes("spawn_subagents")) {
    for (const agent of config.agents) if (!agent.tools.includes("spawn_subagents")) agent.tools.push("spawn_subagents");
    config.subagentsDefaultApplied = true;

    return true;
  }

  return false;
}

function migrateWorkhorse(config: Config, pi: ConfigRuntime) {
  if (config.workhorseDefaultApplied) return false;

  if (!config.agents.some(agent => agent.name === "workhorse")) {
    const agent = structuredClone(config.agents.find(agent => agent.name === "general") ?? generalAgent(pi));
    agent.name = "workhorse";
    delete agent.isDefault;
    config.agents.push(agent);
  }

  config.workhorseDefaultApplied = true;

  return true;
}

export async function loadConfig(pi: ConfigRuntime, supplied?: StoredConfig, initialize = true, storage: ConfigStorage = { ensurePromptFile, writeConfig }): Promise<Config> { return loadMigratedConfig(pi, supplied, initialize, storage); }

async function loadMigratedConfig(pi: ConfigRuntime, supplied: StoredConfig | undefined, initialize: boolean, storage: ConfigStorage): Promise<Config> {
  const config = await readConfig(pi, supplied, initialize, storage);
  let changed = [migrateSessionTools(config, pi), migrateSubagents(config, pi)].some(Boolean);

  for (const agent of config.agents) {
    if (!agent.tools.some((tool) => tool === "exec_command" || tool === "apply_patch")) continue;
    agent.tools = [...new Set(agent.tools.flatMap((tool) => tool === "exec_command"
      ? ["read", "bash", "grep", "find", "ls"]
      : tool === "apply_patch" ? ["edit", "write"] : [tool]))];
    changed = true;
  }

  if (!config.webSearchDefaultApplied && enabledTools(pi)?.includes("web_search")) {
    for (const agent of config.agents) if (!agent.tools.includes("web_search")) agent.tools.push("web_search");
    config.webSearchDefaultApplied = true;
    changed = true;
  }

  const retainedAgents = config.agents.filter(agent => agent.name !== "voice-orchestrator");

  if (retainedAgents.length !== config.agents.length) { config.agents = retainedAgents; changed = true; }

  changed = migrateWorkhorse(config, pi) || changed;

  if (changed) await storage.writeConfig(config);

  return config;
}

function encode<T>(value: T) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"; }

function enabledTools(config: ConfigRuntime) { return config.enabledTools; }

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("A required agent is missing");

  return value;
}

const normalizedPath = resourcePath;

function configureAgentSystemPrompt(prompt: string, agentPrompt: string, options: BuildSystemPromptOptions, invocationPolicy: <T extends { filePath: string; baseDir: string }>(skills: readonly T[]) => T[] = skills => [...skills]) {
  delete options.forceSystemPrompt;
  const instructions = agentPrompt.trim() ? agentPrompt : "";
  options.customPrompt = prompt || " ";
  options.sections = { ...options.sections, instructions };

  options.contextFiles = [];
  delete options.sections.project_context;
  delete options.sections.addendum;
  options.appendSystemPrompt = "";
  options.skills = options.skills && invocationPolicy(options.skills);
}

export default async function defineAgents(pi: ExtensionAPI) {
  /** Rejects agent definitions whose prompt files cannot be read, before they are saved. */
  const requireReadablePrompts = async (agents: Agent[]) => {
    for (const agent of agents) {
      for (const [label, path] of [["System prompt", agent.path_systemprompt], ["Agent prompt", agent.path_agent_prompt]] as const) {
        if (!path?.trim()) continue;

        try { await readPrompt(resolvePromptPath(path)); }
        catch (error) {
          const reason = error instanceof Error && "code" in error && error.code === "ENOENT" ? "does not exist" : `cannot be read: ${error instanceof Error ? error.message : String(error)}`;
          throw new Error(`Agent "${agent.name}": ${label} file ${path} ${reason}`);
        }
      }
    }
  };
  const extensions = agentExtensions(pi, dirname(configPath));
  const initialResources = readAgentResources();
  const configRuntime = { enabledTools: initialResources.tools.enabledTools };
  let config = await loadConfig(configRuntime);
  let active = "general";
  let snapshot: AgentSnapshot | undefined;
  let savedState: string | undefined;
  let locked = false;
  let runtimeDefaults: RuntimeDefaults | undefined;
  let runtimeSession = "";
  let applyingAgentModel: string | undefined;
  let applyingAgentEffort: string | undefined;
  let activeToolError: string | undefined;
  let mcpError: string | undefined;
  let activeSystemPrompt = "";
  let activeAgentPrompt = "";
  let modelOverride: string | undefined;
  let effortOverride: string | undefined;
  let reloading = false;
  /** The default agent's fast mode for a new session. The fast mode extension loads its state in its own session_start, so startup cannot wait for it; the first message does. */
  let startingFastMode: Promise<string | undefined> | undefined;
  process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const defaultAgentName = () => required(config.agents.find(agent => agent.isDefault)).name;
  const currentAgent = () => snapshot?.definition ?? findAgent(active);
  const resources = (): AgentResources => snapshot?.resources ?? initialResources;
  const agentSkills = (_pi: ExtensionAPI, agent: Agent) => {
    const skills = resources().skills;
    const allowed = new Set([...skills.userInvokedSkills, ...skills.agentInvokedSkills].map(resourcePath));
    return agent.skills.filter(path => allowed.has(resourcePath(path)));
  };
  const invocationPolicy = <T extends { filePath: string; baseDir: string }>(skills: readonly T[]): T[] => {
    const user = new Set(resources().skills.userInvokedSkills.map(resourcePath));
    return skills.map(skill => user.has(resourcePath(skill.filePath)) || user.has(resourcePath(skill.baseDir)) ? { ...skill, disableModelInvocation: true } : { ...skill });
  };
  const agentToolError = (api: ExtensionAPI, agent: Agent) => {
    const available = new Set(api.getAllTools().map(tool => tool.name));
    const missing = [...new Set(agent.tools.filter(tool => !available.has(tool)))];
    return missing.length ? `Agent "${agent.name}" cannot run because Pi does not have its configured tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` : undefined;
  };
  registerSubagentLimits(pi, currentAgent);

  const currentMcpTools = (includeInactive = false) => { const request: McpToolsRequest = {}; pi.events.emit("piop:mcp:tools", request);

  return (includeInactive ? request.availableTools : request.tools) ?? []; };

  const toolDisabledForAgent = (name: string, agent: Agent | undefined) => name === "codemode" && agent?.codemode === "off";

  /** Codemode on: the agent gets the codemode tool next to its other tools. Off: it has no codemode tool. Pi without the codemode extension is left as it is. */
  const applyCodemode = (agent: Agent, tools: Set<string>) => {
    if (!pi.getAllTools().some(tool => tool.name === "codemode")) return;

    if (agent.codemode === "off") tools.delete("codemode"); else tools.add("codemode");
  };

  pi.on("tool_call", (event, ctx) => {
    const agent = currentAgent();
    const required: RequiredToolsRequest = { ctx, tools: [], availableTools: agent?.tools }; pi.events.emit("piop:required-tools", required);
    const allowed = agent && !activeToolError && new Set([...agent.tools, ...extensions.tools(), ...currentMcpTools(true), ...required.tools]);

    if (!allowed || !allowed.has(event.toolName) || toolDisabledForAgent(event.toolName, agent)) {
      return { block: true, reason: `Tool ${event.toolName} is not allowed for agent ${agent?.name ?? active}` };
    }
  });

  const stopSubagentProfiles = pi.events.on("piop:agents:subagent", (request) => {
    const agent = request.agent ? findAgent(request.agent) : currentAgent();

    if (!agent) { request.error = `Unknown agent profile ${request.agent ?? "(current)"}. Available profiles: ${config.agents.map(agent => agent.name).join(", ")}`;

    return; }

    const refusal = request.purpose && startRefusal(currentAgent(), agent, request.purpose);

    if (refusal) { request.error = refusal; return; }

    if (!request.agent) {
      request.state = { active: agent.name, locked: false, snapshot: snapshot && structuredClone(snapshot), modelOverride: modelOverride || agent.model || runtimeDefaults?.model, effortOverride: pi.getThinkingLevel() };

      return;
    }

    request.ready = selectedProfileState(agent, initialResources, readPrompt)
      .then(state => { request.state = state; })
      .catch(error => { request.error = `Cannot load agent profile ${agent.name}: ${String(error)}`; });
  });

  const stopProfileCatalog = pi.events.on("piop:agents:profiles", request => {
    const caller = currentAgent();
    request.active = caller?.name;
    request.profiles = config.agents.filter(agent => !startRefusal(caller, agent, request.purpose)).map(agent => ({ name: agent.name, ...(agent.description ? { description: agent.description } : {})}));
  });

  const stopContextCap = pi.events.on("piop:agents:context-cap", request => {
    request.cap = currentAgent()?.contextWindowCap;
  });


  const restoredAgentName = (name: string | undefined) => !name || (name === "default" && !findAgent("default")) ? "general" : name;

  /** The agent a session starts as. Subagent and review sessions store their agent before they start, so only a new root session has no stored state and starts as the default agent. */
  const startingAgentName = (stored: SessionAgentState | undefined) => {
    const name = snapshot?.definition.name ?? (stored ? restoredAgentName(stored.active) : defaultAgentName());

    if (name === "voice-orchestrator") { snapshot = undefined;

      return "general"; }

    return name;
  };

  const currentSkillPaths = () => {
    const agent = currentAgent();

    return [...new Set(agent ? agentSkills(pi, agent).map(normalizedPath) : [])].sort();
  };

  /** Checks an agent's own fast mode default against the host's fast model results. */
  const fastModeError = async (agent: Agent, model: string | undefined) => agent.fastMode === true ? fastModelProblem(await hostFastModels(), agent.name, model) : undefined;

  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active: currentAgent()?.name ?? active, locked, saved: !!snapshot, unavailable: !currentAgent(), config })}`);

  const saveState = (submit = false) => {
    const state = { active, modelOverride, effortOverride, snapshot, locked };

    if (!submit && !locked) {
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

  const snapshotDefinition = ({ isDefault: _isDefault, ...agent }: Agent) => structuredClone({ ...agent, model: agent.model.trim() || runtimeDefaults?.model || "", effort: agent.effort.trim() || runtimeDefaults?.effort || "" });

  const persistAgentSnapshot = async (agent: Agent, persist: boolean) => {
    const savedResources = resources();
    if (snapshot?.version !== 2) snapshot = await snapshotPrompts(snapshotDefinition(agent), activeSystemPrompt, activeAgentPrompt);

    if (!snapshot.resources) snapshot.resources = structuredClone(savedResources);

    if (persist) saveState();
  };

  const prepareAgentPrompts = async (agent: Agent, persistSnapshot: boolean) => {
    activeSystemPrompt = "";
    activeAgentPrompt = "";
    const agentPromptPath = agent.path_agent_prompt;

    if (snapshot?.version === 1) {
      activeSystemPrompt = snapshot.systemPrompt;
      activeAgentPrompt = agentPromptPath ? snapshot.agentPrompt : "";
    } else {
      const path = resolvePromptPath(agent.path_systemprompt);

      try { activeSystemPrompt = await readPrompt(path); }
      catch (error) { pi.setActiveTools([]);

      return `Agent "${agent.name}" cannot read system prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }

      if (agentPromptPath) {
        const path = resolvePromptPath(agentPromptPath);

        try { activeAgentPrompt = await readPrompt(path); }
        catch (error) { pi.setActiveTools([]);

        return `Agent "${agent.name}" cannot read agent prompt ${path}: ${error instanceof Error ? error.message : String(error)}`; }
      }
    }

    await persistAgentSnapshot(agent, persistSnapshot);

  };

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
    const modelName = modelOverride || agent.model.trim() || runtimeDefaults?.model; const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

    if (modelName && modelName !== currentModel) {
      return selectAgentModel(agent, ctx, modelName);
    }

  };

  const configureAgentEffort = (agent: Agent) => {
    const effort = effortOverride || agent.effort.trim() || runtimeDefaults?.effort;

    if (effort && effort !== pi.getThinkingLevel()) {
      const level = agentThinkingLevels.find(value => value === effort);

      if (!level) throw new Error(`Unknown thinking level: ${effort}`);
      applyingAgentEffort = level; pi.setThinkingLevel(level);
    }

  };

  const registerAgentMcp = async (agent: Agent, ctx: ExtensionContext) => {
    try {
      const selection: McpSelection = { codemode: agent.codemode, servers: mcpServers(agent.mcpServers), sessionId: ctx.sessionManager.getSessionId() };
      pi.events.emit("piop:mcp:select", selection);

      if (!selection.registered && Object.keys(selection.servers).length > 0) return `Agent "${agent.name}" cannot run because the MCP registration adapter is unavailable`;

      await selection.registered;
    }
    catch (error) { pi.setActiveTools([]);

    return `Agent "${agent.name}" could not register its MCP servers:\n${error instanceof Error ? error.message : String(error)}`; }
  };

  /** A newly selected agent applies its fast mode default through the fast mode extension's session interface. */
  const applyAgentFastMode = async (agent: Agent) => {
    if (agent.fastMode === undefined) return undefined;
    const session = fastModeSession(pi);

    if (!session) return agent.fastMode ? `Agent "${agent.name}" turns fast mode on, but the fast mode extension is not loaded` : undefined;

    try { await session.setEnabled(agent.fastMode); }
    catch (error) { return `Agent "${agent.name}" could not change fast mode: ${error instanceof Error ? error.message : String(error)}`; }
  };

  /** Unloads the piop extensions of an agent that cannot run, so their providers do not stay registered. */
  const unloadExtensions = async (error: string, ctx: ExtensionContext) => {
    try { await extensions.deactivate(ctx); }
    catch (cleanupError) { ctx.ui.notify(`piop extension cleanup failed: ${String(cleanupError)}`, "error"); }

    return error;
  };

  const activate = async (agent: Agent, ctx: ExtensionContext, { persistSnapshot = true, applyFastMode = false, applyMcp = false }: { persistSnapshot?: boolean; applyFastMode?: boolean; applyMcp?: boolean }) => {
    if (applyMcp) mcpError = await registerAgentMcp(agent, ctx);

    if (mcpError) return unloadExtensions(mcpError, ctx);

    const promptError = await prepareAgentPrompts(agent, persistSnapshot);

    if (promptError) return promptError;

    try { await extensions.activate(await extensions.prepare(extensionPaths(agent.extensions), ctx), ctx); }
    catch (error) { pi.setActiveTools([]);

    return `Agent "${agent.name}" could not load its piop extensions:\n${error instanceof Error ? error.message : String(error)}`; }

    const toolError = agentToolError(pi, agent);

    if (toolError) { pi.setActiveTools([]);

    return unloadExtensions(toolError, ctx); }

    const modelError = await configureAgentModel(agent, ctx);

    if (modelError) return unloadExtensions(modelError, ctx);
    configureAgentEffort(agent);
    const fastModeFailure = applyFastMode ? await applyAgentFastMode(agent) : undefined;

    if (fastModeFailure) { pi.setActiveTools([]);

    return unloadExtensions(fastModeFailure, ctx); }
    const tools = new Set([...agent.tools, ...extensions.tools(), ...currentMcpTools()]);
    const required: RequiredToolsRequest = { ctx, tools: [], availableTools: [...tools] }; pi.events.emit("piop:required-tools", required);

    for (const tool of required.tools) tools.add(tool);
    applyCodemode(agent, tools);
    pi.setActiveTools([...tools]);

    return undefined;
  };

  const useAgent = async (name: string, ctx: ExtensionContext, options: Parameters<typeof activate>[2] = {}) => {
    try {
      restore(ctx);
      const agent = currentAgent();
      activeToolError = agent ? await activate(agent, ctx, options) : `Agent "${name}" is unavailable. This conversation cannot start.`;
    } catch (error) {
      activeToolError = await unloadExtensions(`Agent "${name}" could not start: ${error instanceof Error ? error.message : String(error)}`, ctx);
    }

    if (activeToolError) pi.setActiveTools([]);
    publish(ctx);

    return activeToolError;
  };

  pi.on("session_shutdown", async (event, ctx) => { stopSubagentProfiles(); stopProfileCatalog(); stopContextCap(); await extensions.deactivate(ctx, event); });
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
    const { states, stored, identity } = readAgentState(branch, runtimeSession);
    savedState = identity;
    snapshot = copySnapshot(stored?.snapshot);
    active = startingAgentName(stored);

    locked = sessionIsLocked(states, branch);

    modelOverride = stored?.modelOverride;
    effortOverride = stored?.effortOverride;
    publish(ctx);
    startingFastMode = undefined;
    const error = await useAgent(active, ctx, { applyMcp: true });
    const agent = currentAgent();

    // A new session applies its agent's fast mode. A stored session keeps the fast mode choice that the fast mode extension saved.
    if (!stored && !error && agent) {
      const pending = applyAgentFastMode(agent);
      startingFastMode = pending;
      void pending.then(failure => { if (failure && startingFastMode === pending) { pi.setActiveTools([]); ctx.ui.notify(failure, "warning"); } });
    }

    if (error) ctx.ui.notify(error, "warning");
    publish(ctx);
    pi.events.emit("piop:agents:ready", { ctx });
  };

  pi.on("session_start", (_event, ctx) => restoreSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => { delete process.env.PI_DEFINE_AGENTS_ACTIVE;

  if (!reloading) ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("resources_discover", (_event, ctx) => {
    if (!snapshot) {
      const stored = readAgentState(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile() || "").stored;
      snapshot = copySnapshot(stored?.snapshot);
      active = startingAgentName(stored);
    }
    const agent = currentAgent(); const skillPaths = agent ? agentSkills(pi, agent) : [];

  return skillPaths.length ? { skillPaths } : undefined; });
  pi.on("input", async (event, ctx) => {
    const error = await useAgent(active, ctx) ?? await startingFastMode;

    // useAgent turns the tools on again, so a fast mode failure must turn them off here.
    if (error) { pi.setActiveTools([]); ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error })); ctx.ui.notify(error, "error");

    return { action: "handled" }; }

    if (!locked) { locked = true; publish(ctx); }

    saveState(true);

    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    const agent = currentAgent();

    if (!agent) return;

    if (agent.codemode === "off") pi.setActiveTools(pi.getActiveTools().filter(name => name !== "codemode"));
    configureAgentSystemPrompt(activeSystemPrompt, activeAgentPrompt, event.systemPromptOptions, invocationPolicy);
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "select_agent") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const { agent: name } = Parse(Type.Object({ agent: Type.String() }), request.payload);

      if (!ctx.isIdle()) throw new Error("Wait for the current response before changing agents");
      await selectAgent(name, ctx);
    })();
  });

  const selectAgent = async (name: string, ctx: ExtensionCommandContext) => {
    if (locked) {
      if (name === active) return;
      throw new Error("This conversation's agent is fixed. Start a new conversation to use another agent.");
    }

    const agent = findAgent(name);

    if (!agent) throw new Error(`Unknown defined agent: ${name}`);
    restore(ctx);
    const error = await fastModeError(agent, agent.model.trim() || runtimeDefaults?.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined));

    if (error) throw new Error(error);
    await extensions.prepare(extensionPaths(agent.extensions), ctx);
    const previousActive = active;
    const previousSnapshot = snapshot;
    const previousModel = modelOverride;
    const previousEffort = effortOverride;
    const previousSkills = currentSkillPaths();
    const previousTools = pi.getActiveTools();
    active = name; snapshot = undefined; modelOverride = undefined; effortOverride = undefined;
    const previousFastMode = startingFastMode;
    startingFastMode = undefined;
    const skillsChanged = JSON.stringify(previousSkills) !== JSON.stringify(currentSkillPaths());
    const activationError = await useAgent(active, ctx, { persistSnapshot: false, applyFastMode: true, applyMcp: true });

    if (activationError) { startingFastMode = previousFastMode; active = previousActive; snapshot = previousSnapshot; modelOverride = previousModel; effortOverride = previousEffort; pi.setActiveTools(previousTools); await useAgent(active, ctx, { persistSnapshot: false, applyMcp: true }); throw new Error(activationError); }

    saveState();

    if (skillsChanged) return reload(ctx);
    pi.events.emit("piop:agents:selected", { ctx });
  };

  pi.events.on("piop:rpc", request => {
    if (request.command === "get_agent_configuration") { request.ready = loadConfig(configRuntime);

    return; }

    if (request.command !== "configure_agents") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const schema = Type.Object({ configuration: Type.Object({ revision: Type.String({ minLength: 1 }), agents: Type.Optional(Type.Array(agentSchema)) }) });
      const errors = Errors(schema, request.payload);

      if (errors.length) throw new Error(`Invalid agent configuration: ${errors.map(error => `${error.instancePath} ${error.message}`).join('; ')}`);
      const { configuration: supplied } = Parse(schema, request.payload);
      const stored = await loadConfig(configRuntime);
      const next = normalize({ ...stored, ...supplied }, configRuntime);
      if (supplied.agents) {
        next.sessionToolsDefaultApplied = true;
        next.subagentsDefaultApplied = true;
        next.webSearchDefaultApplied = true;
      }

      for (const agent of next.agents) mcpServersSchema.parse(agent.mcpServers);
      await requireReadablePrompts(next.agents);
      const saved = await writeConfig(next);

      config = next;

      try { publish(ctx); } catch (error) { saved?.warnings.push(`Agent definitions were saved, but their status could not be updated: ${String(error)}`); }

      return { revision: next.revision, warnings: saved?.warnings };
    })();
  });
}
