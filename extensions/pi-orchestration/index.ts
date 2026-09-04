import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Agent = { name: string; description: string; model: string; effort: string; systemPrompt: string; developerPrompt: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[] };
type Sequence = { name: string; description: string; agents: string[]; visibleSteps: number };
type Config = { agents: Agent[]; sequences: Sequence[] };
type Run = { sequence: Sequence; index: number; final: string; failed: boolean };
type Delegation = { agent: string; task: string; final: string };
type RuntimeDefaults = { model: string; effort: string };

const STATUS_KEY = "pi-desktop-orchestration";
const STATE_ENTRY = "pi-orchestration-state";
const RUN_ENTRY = "pi-orchestration-run";
const SEQUENCE_MARKER_ENTRY = "pi-orchestration-sequence-marker";
const DEFAULTS_ENV = "PI_ORCHESTRATION_RUNTIME_DEFAULTS";
const HANDOFF = /^<!-- pi-desktop-sequence:/;
const CHILD_OUTPUT_LIMIT = 4 * 1024 * 1024;
const execFile = promisify(execFileCallback);
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const extensionPath = fileURLToPath(import.meta.url);
const fallbackConfig: Config = { agents: [{ name: "default", description: "General-purpose agent", model: "", effort: "high", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "read_trace"], skills: [], mcpServers: [] }], sequences: [] };

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
  const names = new Set(agents.map((agent) => agent.name));
  const sequences = Array.isArray(value.sequences) ? value.sequences.filter((sequence) => sequence && typeof sequence.name === "string" && sequence.name.length > 0 && Array.isArray(sequence.agents) && sequence.agents.length > 0 && sequence.agents.every((name) => names.has(name))).map((sequence) => ({ ...sequence, description: sequence.description || "", visibleSteps: Math.max(1, Math.min(sequence.agents.length, Number(sequence.visibleSteps) || sequence.agents.length)) })) : [];
  return { agents, sequences };
}


async function loadConfig() {
  let content: string;
  try { content = await readFile(configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fallback = structuredClone(fallbackConfig); await writeConfig(fallback); return fallback;
  }
  try { return normalize(JSON.parse(content)); }
  catch (error) { throw new Error(`Could not parse orchestration config ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode<T>(value: string): T { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; }
function marker(text: string, sequence: Sequence, index: number) { return `<!-- pi-desktop-sequence:${encodeURIComponent(JSON.stringify({ sequence: sequence.name, step: index, agent: sequence.agents[index], visible: true }))} -->\n${text}`; }
function finalText(messages: any[]) {
  const userIndex = messages.findLastIndex((message) => message?.role === "user");
  const message = messages.slice(userIndex + 1).findLast((candidate) => candidate?.role === "assistant");
  if (!message) return { text: "", failed: true };
  const text = message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") || "";
  return { text: text.trim(), failed: !text.trim() || message.stopReason === "error" || message.stopReason === "aborted" };
}
function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"; }
function multiAgentMode(value: string): "final-only" | "own+final" | undefined { return value === "orchestrator" ? "final-only" : value === "final-only" || value === "own+final" ? value : undefined; }
function desktopList(name: string) { try { const value = JSON.parse(process.env[name] || "null"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined; } catch { return undefined; } }
function normalizedPath(value: string) { return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }
function agentSkills(agent: Agent) { const global = desktopList("PI_DESKTOP_SKILL_PATHS"); if (!global) return agent.skills; const allowed = new Set(global.map(normalizedPath)); return agent.skills.filter((skill) => allowed.has(normalizedPath(skill))); }
function agentToolError(pi: ExtensionAPI, agent: Agent) {
  const globallyAllowed = desktopList("PI_DESKTOP_ALLOWED_TOOLS"); const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const denied = [...new Set(agent.tools.filter((tool) => (globallyAllowed && !globallyAllowed.includes(tool)) || !available.has(tool)))];
  return denied.length ? `Agent "${agent.name}" cannot run because Pi does not allow its configured tool${denied.length === 1 ? "" : "s"}: ${denied.join(", ")}` : undefined;
}

function piInvocation(args: string[]) {
  const script = process.argv[1];
  return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: process.execPath, args };
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
  return args;
}

async function runChild(agent: Agent, task: string, cwd: string, signal?: AbortSignal, session?: string, defaults?: RuntimeDefaults) {
  const invocation = piInvocation([...agentArgs(agent, session, defaults), task]);
  try {
    const { stdout } = await execFile(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, PI_ORCHESTRATION_CHILD: encode(agent), PI_DESKTOP_MCP_ALLOWED_SERVER_IDS: agent.mcpServers.join(",") },
      encoding: "utf8",
      maxBuffer: CHILD_OUTPUT_LIMIT,
      signal,
    });
    return stdout.trim() || "(no response)";
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string };
    if (signal?.aborted) throw new Error("Agent was stopped");
    throw new Error(failure.stderr?.trim() || (typeof failure.code === "number" ? `Agent exited with code ${failure.code}` : failure.message));
  }
}

export default async function orchestration(pi: ExtensionAPI) {
  if (process.env.PI_ORCHESTRATION_CHILD) {
    const childAgent = decode<Agent>(process.env.PI_ORCHESTRATION_CHILD);
    pi.on("session_start", () => {
      const childToolError = agentToolError(pi, childAgent);
      if (childToolError) { pi.setActiveTools([]); process.stderr.write(`${childToolError}\n`, () => process.exit(1)); return; }
      const allowed = new Set(childAgent.tools);
      for (const info of pi.getAllTools()) if (childAgent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) allowed.add(info.name);
      pi.setActiveTools([...allowed]);
    });
    return;
  }
  process.env.PI_DESKTOP_ORCHESTRATION_ACTIVE = "1";
  let config = await loadConfig(); let active = "default"; let run: Run | undefined; let pendingHandoff: string | undefined; let authorizedHandoff: string | undefined; let activeToolError: string | undefined; let originalTask = ""; let delegations: Delegation[] = []; let runtimeDefaults: RuntimeDefaults | undefined; let runtimeSession = ""; let applyingAgentModel: string | undefined; let applyingAgentEffort: string | undefined; const backgroundControllers = new Set<AbortController>();
  const saveRuntimeDefaults = (value: RuntimeDefaults) => { runtimeDefaults = value; process.env[DEFAULTS_ENV] = JSON.stringify({ ...value, session: runtimeSession }); };

  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const findSequence = (name: string) => config.sequences.find((sequence) => sequence.name === name);
  const currentAgent = () => multiAgentMode(active) ? undefined : findSequence(active) ? findAgent(run?.sequence.agents[run.index] || findSequence(active)!.agents[0]) : findAgent(active);
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active, currentAgent: currentAgent()?.name, config })}`);
  const saveActive = (ctx: ExtensionContext) => { pi.appendEntry(STATE_ENTRY, { active }); publish(ctx); };
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
  const activateTarget = async (ctx: ExtensionContext) => {
    if (multiAgentMode(active)) { activeToolError = undefined; pi.setActiveTools(["call_agent"]); return; }
    const sequence = findSequence(active); const agent = findAgent(run?.sequence.agents[run.index] || sequence?.agents[0] || active);
    activeToolError = agent ? await activate(agent, ctx) : undefined;
  };
  pi.on("resources_discover", () => {
    const agent = currentAgent(); const skillPaths = agent ? agentSkills(agent) : [];
    if (pendingHandoff && run) {
      const handoff = pendingHandoff; const sequence = run.sequence; const index = run.index;
      pendingHandoff = undefined; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index });
      const message = marker(handoff, sequence, index); authorizedHandoff = message; pi.appendEntry(SEQUENCE_MARKER_ENTRY, { message }); setTimeout(() => pi.sendUserMessage(message), 0);
    }
    return skillPaths.length ? { skillPaths } : undefined;
  });
  pi.on("session_shutdown", () => { for (const controller of backgroundControllers) controller.abort(); backgroundControllers.clear(); delete process.env.PI_DESKTOP_ORCHESTRATION_ACTIVE; });
  pi.on("model_select", (event) => { const model = `${event.model.provider}/${event.model.id}`; if (applyingAgentModel === model) { applyingAgentModel = undefined; return; } saveRuntimeDefaults({ model, effort: runtimeDefaults?.effort || pi.getThinkingLevel() }); });
  pi.on("thinking_level_select", (event) => { if (applyingAgentEffort === event.level) { applyingAgentEffort = undefined; return; } saveRuntimeDefaults({ model: runtimeDefaults?.model || "", effort: event.level }); });

  const registerTool = () => pi.registerTool({
    name: "call_agent", label: "Call agent or sequence",
    description: `Call one configured agent or sequence, or use target "done" when the user's job is complete. Available:\n${[...config.agents, ...config.sequences].map((item) => `${item.name}: ${item.description || ("agents" in item ? "Sequence" : "Agent")}`).join("\n")}`,
    parameters: Type.Object({ target: Type.String({ description: "Exact agent or sequence name, or done" }), task: Type.String({ description: "Task to pass to it, or the final answer when done" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.target === "done") return { content: [{ type: "text", text: `Job complete. Reply to the user with this final answer:\n\n${params.task}` }], details: { done: true } };
      const sequence = findSequence(params.target); const names = sequence?.agents ?? [params.target]; let output = params.task;
      for (const name of names) {
        const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent or sequence: ${params.target}`); const toolError = agentToolError(pi, agent); if (toolError) throw new Error(toolError); onUpdate?.({ content: [{ type: "text", text: `${name} running…` }] });
        const mode = multiAgentMode(active); const prior = delegations.map((item) => `${mode === "own+final" && item.agent === name ? `[Your request]\n${item.task}\n` : ""}[Final from ${item.agent}]\n${item.final}`).join("\n\n");
        const task = mode ? `[Original user request]\n${originalTask}${prior ? `\n\n${prior}` : ""}\n\n[Your current request]\n${output}` : output;
        const requested = output; output = await runChild(agent, task, ctx.cwd, signal, undefined, runtimeDefaults); if (mode) delegations.push({ agent: name, task: requested, final: output });
      }
      return { content: [{ type: "text", text: output }], details: { target: params.target, agents: names } };
    }
  });
  registerTool();

  pi.registerCommand("pi-orchestration-use", { description: "Select a Pi orchestration agent or sequence", handler: async (args, ctx) => {
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* CLI users may pass a plain name */ }
    if (!multiAgentMode(name) && !findAgent(name) && !findSequence(name)) throw new Error(`Unknown orchestration target: ${name}`);
    active = name; run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
  }});
  pi.registerCommand("pi-orchestration-config", { description: "Update Pi orchestration configuration", handler: async (args, ctx) => {
    const next = normalize(decode<Config>(args.trim())); const previous = config; const previousActive = active; await writeConfig(next); config = next;
    try {
      if (!multiAgentMode(active) && !findAgent(active) && !findSequence(active)) active = config.agents[0]?.name || "default";
      run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
    } catch (error) { await writeConfig(previous); config = previous; active = previousActive; throw error; }
  }});
  pi.registerCommand("pi-orchestration-next", { description: "Continue an orchestration sequence after reloading its resources", handler: async (args, ctx) => {
    const next = decode<{ sequence: string; index: number; handoff: string }>(args.trim()); const sequence = findSequence(next.sequence);
    if (!sequence || next.index < 0 || next.index >= sequence.agents.length || typeof next.handoff !== "string") throw new Error("Invalid sequence handoff");
    pi.appendEntry(RUN_ENTRY, next); await ctx.reload();
  }});
  pi.on("session_start", async (_event, ctx) => {
    runtimeSession = ctx.sessionManager.getSessionFile() || "";
    try { const stored = JSON.parse(process.env[DEFAULTS_ENV] || "null"); if (stored?.session === runtimeSession && typeof stored.model === "string" && typeof stored.effort === "string") runtimeDefaults = { model: stored.model, effort: stored.effort }; } catch { /* Capture clean runtime defaults below. */ }
    let savedRun: { sequence?: string; index?: number; handoff?: string } | undefined;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom") {
      if (entry.customType === STATE_ENTRY && typeof (entry.data as any)?.active === "string") active = (entry.data as any).active;
      if (entry.customType === RUN_ENTRY) savedRun = entry.data as typeof savedRun;
    }
    if (!runtimeDefaults) saveRuntimeDefaults({ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", effort: pi.getThinkingLevel() });
    if (active === "orchestrator") active = "final-only";
    if (!multiAgentMode(active) && !findAgent(active) && !findSequence(active)) active = config.agents[0]?.name || "default";
    const sequence = typeof savedRun?.sequence === "string" ? findSequence(savedRun.sequence) : undefined; const index = Number(savedRun?.index);
    run = sequence?.name === active && Number.isInteger(index) && index >= 0 && index < sequence.agents.length ? { sequence, index, final: "", failed: false } : undefined;
    pendingHandoff = run && typeof savedRun?.handoff === "string" ? savedRun.handoff : undefined;
    await activateTarget(ctx);
    publish(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/")) return { action: "continue" };
    if (activeToolError) { if (run) pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; }
    if (HANDOFF.test(event.text)) { if (event.text === authorizedHandoff) { authorizedHandoff = undefined; return { action: "continue" }; } return { action: "transform", text: event.text.replace("<!-- pi-desktop-sequence:", "<!-- user-text-pi-desktop-sequence:"), images: event.images }; }
    const text = event.text;
    const sequence = findSequence(active);
    if (sequence) { run = { sequence, index: 0, final: "", failed: false }; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index: 0 }); const agent = findAgent(sequence.agents[0]); activeToolError = agent ? await activate(agent, ctx) : undefined; if (activeToolError) { pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } const marked = marker(text, sequence, 0); pi.appendEntry(SEQUENCE_MARKER_ENTRY, { message: marked }); return { action: "transform", text: marked, images: event.images }; }
    if (multiAgentMode(active)) { originalTask = text; delegations = []; pi.setActiveTools(["call_agent"]); return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images }; }
    const agent = findAgent(active); activeToolError = agent ? await activate(agent, ctx) : undefined; if (activeToolError) { ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (multiAgentMode(active)) { const agentsMd = findAgent("default")?.agentsMd.trim(); return { systemPrompt: `${event.systemPrompt}\n\nYou are an ephemeral orchestrator. Delegate every pass through call_agent. Call another agent until the job is complete, then call target "done" and answer the user. Agents receive ${multiAgentMode(active) === "final-only" ? "only the original request and chronological final messages" : "their own requests plus every chronological final message"}.${agentsMd ? `\n\n# AGENTS.md\n\n${agentsMd}` : ""}` }; }
    const agent = currentAgent(); if (!agent) return;
    const additions = [agent.systemPrompt, agent.developerPrompt, agent.agentsMd ? `# Agent AGENTS.md\n\n${agent.agentsMd}` : ""].filter((text) => text.trim()).join("\n\n");
    return additions ? { systemPrompt: `${event.systemPrompt}\n\n${additions}` } : undefined;
  });
  pi.on("agent_end", (event) => { if (run) { const result = finalText(event.messages as any[]); run.final = result.text; run.failed = result.failed; } });
  pi.on("agent_settled", async (_event, ctx) => {
    const current = run; if (!current || current.failed || !current.final) { if (current) pi.appendEntry(RUN_ENTRY, null); run = undefined; return; }
    const nextIndex = current.index + 1; const visible = Math.min(Math.max(1, current.sequence.visibleSteps), current.sequence.agents.length);
    if (nextIndex < visible) { const handoff = { sequence: current.sequence.name, index: nextIndex, handoff: current.final }; run = undefined; pi.sendUserMessage(`/pi-orchestration-next ${encode(handoff)}`, { expandPromptTemplates: true }); return; }
    pi.appendEntry(RUN_ENTRY, null); run = undefined;
    const background = current.sequence.agents.slice(visible); if (!background.length) return;
    const session = ctx.sessionManager.getSessionFile(); if (!session) { ctx.ui.notify("Background sequence requires a persisted session", "error"); return; }
    const controller = new AbortController(); backgroundControllers.add(controller);
    void (async () => { const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-")); try { const branch = join(temporary, "branch.jsonl"); await copyFile(session, branch); let output = current.final; for (const name of background) { const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent: ${name}`); const toolError = agentToolError(pi, agent); if (toolError) throw new Error(toolError); output = await runChild(agent, output, ctx.cwd, controller.signal, branch, runtimeDefaults); } } catch (error) { if (!controller.signal.aborted) ctx.ui.notify(`Background sequence failed: ${error instanceof Error ? error.message : String(error)}`, "error"); } finally { backgroundControllers.delete(controller); await rm(temporary, { recursive: true, force: true }); } })();
  });
}
