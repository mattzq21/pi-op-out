import { constants } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Agent = { name: string; description: string; model: string; effort: string; systemPrompt: string; developerPrompt: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[] };
type RuntimeDefaults = { model: string; effort: string };

// Consumers discover this loaded extension through Pi's event bus. Type-only
// imports do not require the extension to be installed at runtime.
export type DefinedAgents = {
  version: 1;
  list(): Agent[];
  use(name: string, ctx: ExtensionContext): Promise<string | undefined>;
  check(agent: Agent): string | undefined;
  child(agent: Agent, session?: string): { args: string[]; env: Record<string, string> };
  manage(current: () => string | undefined, select: (name: string) => void): void;
};

const STATUS_KEY = "pi-define-agents";
const STATE_ENTRY = "pi-define-agents-state";
const DEFAULTS_ENV = "PI_DEFINE_AGENTS_RUNTIME_DEFAULTS";
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const extensionPath = fileURLToPath(import.meta.url);
type Config = { agents: Agent[] };
const fallbackConfig: Config = { agents: [{ name: "default", description: "General-purpose agent", model: "", effort: "high", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: [] }] };

async function writeConfig(value: Config) {
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, configPath); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function normalize(value: Partial<Config>): Config {
  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => agent && typeof agent.name === "string" && agent.name.length > 0).map((agent) => ({
    name: agent.name, description: typeof agent.description === "string" ? agent.description : "", model: typeof agent.model === "string" ? agent.model : "", effort: typeof agent.effort === "string" ? agent.effort : fallbackConfig.agents[0].effort,
    systemPrompt: typeof agent.systemPrompt === "string" ? agent.systemPrompt : "", developerPrompt: typeof agent.developerPrompt === "string" ? agent.developerPrompt : "", agentsMd: typeof agent.agentsMd === "string" ? agent.agentsMd : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => typeof item === "string") : [...fallbackConfig.agents[0].tools], skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => typeof item === "string") : [], mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers.filter((item): item is string => typeof item === "string" && item !== "filesystem") : [],
  })) : [];
  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "default") ? unique : [structuredClone(fallbackConfig.agents[0]), ...unique];
  return { agents };
}

async function loadConfig(): Promise<Config> {
  // Complete migration in this order: backup, agents, sequences. A restart after
  // any write can retry without replacing an already-created agents file.
  let config: Config | undefined;
  try { config = normalize(JSON.parse(await readFile(configPath, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read agent definitions ${configPath}: ${error}`); }
  const legacyPath = join(dirname(configPath), "..", "pi-orchestration", "config.json");
  let legacy: { agents?: Agent[]; sequences?: unknown[] } | undefined;
  try { legacy = JSON.parse(await readFile(legacyPath, "utf8")); }
  catch (error) {
    // Once definitions exist, broken or unavailable orchestration configuration
    // must not prevent standalone agent use.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (config) return config;
      throw new Error(`Could not read legacy orchestration config ${legacyPath}: ${error}`);
    }
  }
  if (Array.isArray(legacy?.agents)) {
    try { await copyFile(legacyPath, `${legacyPath}.pre-define-agents.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!config) { config = normalize({ agents: legacy?.agents }); await writeConfig(config); }
  if (Array.isArray(legacy?.agents)) {
    const temporary = `${legacyPath}.${process.pid}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify({ sequences: legacy.sequences ?? [] }, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, legacyPath); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
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

function agentArgs(agent: Agent, session?: string, defaults?: RuntimeDefaults) {
  const args = ["--mode", "text", "-p", "--approve", "--no-skills"];
  if (session) args.push("--session", session); else args.push("--no-session");
  const model = agent.model.trim() || defaults?.model.trim(); const effort = agent.effort.trim() || defaults?.effort.trim();
  if (model) args.push("--model", model);
  if (effort) args.push("--thinking", effort);
  if (agent.systemPrompt.trim()) args.push("--system-prompt", agent.systemPrompt.trim());
  if (agent.developerPrompt.trim()) args.push("--append-system-prompt", agent.developerPrompt.trim());
  if (agent.agentsMd.trim()) args.push("--append-system-prompt", `# Agent AGENTS.md\n\n${agent.agentsMd.trim()}`);
  for (const skill of agentSkills(agent)) args.push("--skill", skill);
  const contextWindowCapExtension = process.env.PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION;
  if (contextWindowCapExtension) args.push("--extension", contextWindowCapExtension);
  const traceReaderExtension = process.env.PI_DESKTOP_TRACE_READER_EXTENSION;
  if (traceReaderExtension) args.push("--extension", traceReaderExtension);
  args.push("--extension", extensionPath);
  const mcpConfig = process.env.PI_DESKTOP_MCP_CONFIG;
  if (mcpConfig) args.push("--extension", join(dirname(mcpConfig), "pi-desktop-mcp-bridge.ts"));
  const codexCompactionExtension = process.env.PI_DESKTOP_CODEX_COMPACTION_EXTENSION;
  if (codexCompactionExtension) args.push("--extension", codexCompactionExtension);
  return args;
}

export default async function defineAgents(pi: ExtensionAPI) {
  if (process.env.PI_DEFINE_AGENTS_CHILD) {
    const childAgent = decode<Agent>(process.env.PI_DEFINE_AGENTS_CHILD);
    process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
    pi.on("session_shutdown", () => { delete process.env.PI_DEFINE_AGENTS_ACTIVE; });
    pi.on("session_start", () => {
      const childToolError = agentToolError(pi, childAgent);
      if (childToolError) { pi.setActiveTools([]); process.stderr.write(`${childToolError}\n`, () => process.exit(1)); return; }
      const allowed = new Set(childAgent.tools);
      for (const info of pi.getAllTools()) if (childAgent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) allowed.add(info.name);
      pi.setActiveTools([...allowed]);
    });
    return;
  }
  let config = await loadConfig();
  let active = "default";
  let runtimeDefaults: RuntimeDefaults | undefined;
  let runtimeSession = "";
  let applyingAgentModel: string | undefined;
  let applyingAgentEffort: string | undefined;
  let activeToolError: string | undefined;
  let managed: { current: () => string | undefined; select: (name: string) => void } | undefined;
  process.env.PI_DEFINE_AGENTS_ACTIVE = "1";
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const currentAgent = () => { const name = managed ? managed.current() : active; return name ? findAgent(name) : undefined; };
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active: currentAgent()?.name ?? active, config })}`);
  const saveRuntimeDefaults = (value: RuntimeDefaults) => { runtimeDefaults = value; process.env[DEFAULTS_ENV] = JSON.stringify({ ...value, session: runtimeSession }); };
  const restore = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionFile() || "";
    if (runtimeDefaults && runtimeSession === session) return;
    runtimeSession = session;
    runtimeDefaults = undefined;
    try { const stored = JSON.parse(process.env[DEFAULTS_ENV] || process.env.PI_ORCHESTRATION_RUNTIME_DEFAULTS || "null"); if (stored?.session === session && typeof stored.model === "string" && typeof stored.effort === "string") runtimeDefaults = { model: stored.model, effort: stored.effort }; } catch { /* Capture clean runtime defaults below. */ }
    if (!runtimeDefaults) saveRuntimeDefaults({ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", effort: pi.getThinkingLevel() });
  };
  const activate = async (agent: Agent, ctx: ExtensionContext) => {
    const toolError = agentToolError(pi, agent); if (toolError) { pi.setActiveTools([]); return toolError; }
    const modelName = agent.model.trim() || runtimeDefaults?.model; const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    if (modelName && modelName !== currentModel) {
      const [provider, ...parts] = modelName.split("/"); const model = ctx.modelRegistry.find(provider, parts.join("/"));
      if (!model) { pi.setActiveTools([]); return `Agent "${agent.name}" cannot run because model ${modelName} is unavailable`; }
      try { applyingAgentModel = modelName; const selected = await pi.setModel(model); if (!selected && applyingAgentModel === modelName) applyingAgentModel = undefined; } catch (error) { if (applyingAgentModel === modelName) applyingAgentModel = undefined; pi.setActiveTools([]); return `Agent "${agent.name}" could not select ${modelName}: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const effort = agent.effort.trim() || runtimeDefaults?.effort; if (effort && effort !== pi.getThinkingLevel()) { applyingAgentEffort = effort; pi.setThinkingLevel(effort as any); }
    const tools = new Set(agent.tools);
    for (const info of pi.getAllTools()) if (agent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) tools.add(info.name);
    pi.setActiveTools([...tools]); return undefined;
  };
  const definitions: DefinedAgents = {
    version: 1,
    list: () => structuredClone(config.agents),
    use: async (name, ctx) => {
      restore(ctx);
      const agent = findAgent(name);
      activeToolError = agent ? await activate(agent, ctx) : `Unknown defined agent: ${name}`;
      if (activeToolError) pi.setActiveTools([]);
      publish(ctx);
      return activeToolError;
    },
    check: (agent) => agentToolError(pi, agent),
    child: (agent, session) => ({ args: agentArgs(agent, session, runtimeDefaults), env: { PI_DEFINE_AGENTS_CHILD: encode(agent), PI_DESKTOP_MCP_ALLOWED_SERVER_IDS: agent.mcpServers.join(",") } }),
    manage: (current, select) => { managed = { current, select }; },
  };
  const unsubscribe = pi.events.on("pi-define-agents:request", (receive) => { if (typeof receive === "function") receive(definitions); });
  pi.events.emit("pi-define-agents:ready", definitions);
  pi.on("model_select", (event) => { const model = `${event.model.provider}/${event.model.id}`; if (applyingAgentModel === model) { applyingAgentModel = undefined; return; } saveRuntimeDefaults({ model, effort: runtimeDefaults?.effort || pi.getThinkingLevel() }); });
  pi.on("thinking_level_select", (event) => { if (applyingAgentEffort === event.level) { applyingAgentEffort = undefined; return; } saveRuntimeDefaults({ model: runtimeDefaults?.model || "", effort: event.level }); });
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    active = "default";
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && (entry.customType === STATE_ENTRY || entry.customType === "pi-orchestration-state")) {
      const name = (entry.data as { active?: string })?.active;
      if (name && findAgent(name)) active = name;
    }
    if (!managed) await definitions.use(active, ctx);
    publish(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { unsubscribe(); delete process.env.PI_DEFINE_AGENTS_ACTIVE; ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("resources_discover", () => { const agent = currentAgent(); const skillPaths = agent ? agentSkills(agent) : []; return skillPaths.length ? { skillPaths } : undefined; });
  pi.on("input", async (event, ctx) => {
    if (managed || event.text.startsWith("/")) return { action: "continue" };
    const error = await definitions.use(active, ctx);
    if (error) { ctx.ui.notify(error, "error"); return { action: "handled" }; }
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    const agent = currentAgent(); if (!agent) return;
    const additions = [agent.systemPrompt, agent.developerPrompt, agent.agentsMd ? `# Agent AGENTS.md\n\n${agent.agentsMd}` : ""].filter((text) => text.trim()).join("\n\n");
    return additions ? { systemPrompt: `${event.systemPrompt}\n\n${additions}` } : undefined;
  });
  pi.registerCommand("pi-define-agents-use", { description: "Select a defined agent", handler: async (args, ctx) => {
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* Plain CLI name. */ }
    if (!findAgent(name)) throw new Error(`Unknown defined agent: ${name}`);
    active = name; managed?.select(name);
    pi.appendEntry(STATE_ENTRY, { active }); await ctx.reload();
  }});
  pi.registerCommand("pi-define-agents-config", { description: "Update agent definitions", handler: async (args, ctx) => {
    const previous = config;
    const next = normalize(decode<Config>(args.trim())); await writeConfig(next); config = next;
    try { if (!managed) { if (!findAgent(active)) active = "default"; pi.appendEntry(STATE_ENTRY, { active }); } await ctx.reload(); }
    catch (error) { await writeConfig(previous); config = previous; throw error; }
  }});
}
