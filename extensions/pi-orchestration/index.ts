import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Agent = { name: string; description: string; model: string; effort: string; systemPrompt: string; developerPrompt: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[] };
type Sequence = { name: string; description: string; agents: string[]; visibleSteps: number };
type Config = { agents: Agent[]; sequences: Sequence[] };
type Run = { sequence: Sequence; index: number; final: string; failed: boolean };

const STATUS_KEY = "pi-desktop-orchestration";
const STATE_ENTRY = "pi-orchestration-state";
const RUN_ENTRY = "pi-orchestration-run";
const HANDOFF = /^<!-- pi-desktop-sequence:/;
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const extensionPath = fileURLToPath(import.meta.url);
const fallbackConfig: Config = { agents: [{ name: "default", description: "General-purpose agent", model: "", effort: "high", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: [] }], sequences: [] };
let migratedActive: string | undefined;

function normalize(value: Partial<Config>): Config {
  const supplied = Array.isArray(value.agents) ? value.agents.filter((agent) => agent && typeof agent.name === "string" && agent.name.length > 0).map((agent) => ({
    name: agent.name, description: typeof agent.description === "string" ? agent.description : "", model: typeof agent.model === "string" ? agent.model : "", effort: typeof agent.effort === "string" ? agent.effort : fallbackConfig.agents[0].effort,
    systemPrompt: typeof agent.systemPrompt === "string" ? agent.systemPrompt : "", developerPrompt: typeof agent.developerPrompt === "string" ? agent.developerPrompt : "", agentsMd: typeof agent.agentsMd === "string" ? agent.agentsMd : "",
    tools: Array.isArray(agent.tools) ? agent.tools.filter((item): item is string => typeof item === "string") : [...fallbackConfig.agents[0].tools], skills: Array.isArray(agent.skills) ? agent.skills.filter((item): item is string => typeof item === "string") : [], mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers.filter((item): item is string => typeof item === "string") : [],
  })) : [];
  const unique = supplied.filter((agent, index) => supplied.findIndex((candidate) => candidate.name === agent.name) === index);
  const agents = unique.some((agent) => agent.name === "default") ? unique : [structuredClone(fallbackConfig.agents[0]), ...unique];
  const names = new Set(agents.map((agent) => agent.name));
  const sequences = Array.isArray(value.sequences) ? value.sequences.filter((sequence) => sequence && typeof sequence.name === "string" && sequence.name.length > 0 && Array.isArray(sequence.agents) && sequence.agents.length > 0 && sequence.agents.every((name) => names.has(name))).map((sequence) => ({ ...sequence, description: sequence.description || "", visibleSteps: Math.max(1, Math.min(sequence.agents.length, Number(sequence.visibleSteps) || sequence.agents.length)) })) : [];
  return { agents, sequences };
}

async function legacySettings() {
  const home = homedir();
  const candidates = [
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "dev.pi.desktop", "settings.json") : "",
    join(home, ".config", "dev.pi.desktop", "settings.json"),
    join(home, "Library", "Application Support", "dev.pi.desktop", "settings.json"),
    process.env.APPDATA ? join(process.env.APPDATA, "dev.pi.desktop", "settings.json") : "",
  ].filter(Boolean);
  for (const path of candidates) try { return JSON.parse(await readFile(path, "utf8")) as { activeAgent?: string; sequences?: Sequence[] }; } catch { /* try the next platform path */ }
  return {};
}

function yamlScalar(value: string) {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (trimmed === "''" || trimmed === '""') return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) try { return JSON.parse(trimmed) as string; } catch { /* use it literally */ }
  return trimmed;
}

function parseLegacyAgentYaml(source: string): Agent {
  const value: Record<string, unknown> = {}; const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/); if (!match) continue;
    const [, key, raw = ""] = match;
    if (/^[|>][-+]?$/u.test(raw.trim())) {
      const folded = raw.trim().startsWith(">"); const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || lines[index + 1] === "")) block.push(lines[++index].replace(/^ {2}/, ""));
      value[key] = folded ? block.join(" ").trimEnd() : block.join("\n").trimEnd(); continue;
    }
    if (!raw.trim()) {
      const items: string[] = [];
      while (index + 1 < lines.length) { const item = lines[index + 1].match(/^\s*-\s*(.*)$/); if (!item) break; index += 1; items.push(yamlScalar(item[1])); }
      value[key] = items; continue;
    }
    value[key] = yamlScalar(raw);
  }
  return value as unknown as Agent;
}

async function migrateLegacyConfig() {
  const directory = join(homedir(), ".pi-desktop", "agents");
  let files: string[]; try { files = (await readdir(directory)).filter((file) => /\.ya?ml$/i.test(file)); } catch { return undefined; }
  const agents: Agent[] = [];
  for (const file of files) try { agents.push(parseLegacyAgentYaml(await readFile(join(directory, file), "utf8"))); } catch { /* leave malformed legacy profiles untouched */ }
  if (!agents.length) return undefined;
  const settings = await legacySettings(); migratedActive = settings.activeAgent;
  const config = normalize({ agents, sequences: settings.sequences ?? [] });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

async function loadConfig() {
  try { return normalize(JSON.parse(await readFile(configPath, "utf8"))); }
  catch {
    const migrated = await migrateLegacyConfig(); if (migrated) return migrated;
    const fallback = structuredClone(fallbackConfig); await writeFile(configPath, `${JSON.stringify(fallback, null, 2)}\n`, { mode: 0o600 }); return fallback;
  }
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode<T>(value: string): T { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; }
function marker(text: string, sequence: Sequence, index: number) { return `<!-- pi-desktop-sequence:${encodeURIComponent(JSON.stringify({ sequence: sequence.name, step: index, agent: sequence.agents[index], visible: true }))} -->\n${text}`; }
function finalText(messages: any[]) { for (let index = messages.length - 1; index >= 0; index -= 1) { const message = messages[index]; if (message?.role !== "assistant") continue; const text = message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") || ""; if (text.trim()) return { text: text.trim(), failed: message.stopReason === "error" || message.stopReason === "aborted" }; } return { text: "", failed: true }; }
function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"; }
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

function agentArgs(agent: Agent, session?: string) {
  const args = ["--mode", "text", "-p", "--approve", "--no-skills"];
  if (session) args.push("--session", session); else args.push("--no-session");
  if (agent.model.trim()) args.push("--model", agent.model.trim());
  if (agent.effort.trim()) args.push("--thinking", agent.effort.trim());
  if (agent.systemPrompt.trim()) args.push("--system-prompt", agent.systemPrompt.trim());
  if (agent.developerPrompt.trim()) args.push("--append-system-prompt", agent.developerPrompt.trim());
  if (agent.agentsMd.trim()) args.push("--append-system-prompt", `# Agent AGENTS.md\n\n${agent.agentsMd.trim()}`);
  for (const skill of agentSkills(agent)) args.push("--skill", skill);
  args.push("--extension", extensionPath);
  const mcpConfig = process.env.PI_DESKTOP_MCP_CONFIG;
  if (mcpConfig) args.push("--extension", join(dirname(mcpConfig), "pi-desktop-mcp-bridge.ts"));
  return args;
}

async function runChild(agent: Agent, task: string, cwd: string, signal?: AbortSignal, session?: string) {
  const invocation = piInvocation([...agentArgs(agent, session), task]);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, env: { ...process.env, PI_ORCHESTRATION_CHILD: encode(agent), PI_DESKTOP_MCP_ALLOWED_SERVER_IDS: agent.mcpServers.join(",") }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(output.trim() || "(no response)") : reject(new Error(error.trim() || `Agent exited with code ${code}`)));
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
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
  let config = await loadConfig(); let active = migratedActive ?? "default"; let run: Run | undefined; let pendingHandoff: string | undefined; let activeToolError: string | undefined;

  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);
  const findSequence = (name: string) => config.sequences.find((sequence) => sequence.name === name);
  const currentAgent = () => active === "orchestrator" ? undefined : findSequence(active) ? findAgent(run?.sequence.agents[run.index] || findSequence(active)!.agents[0]) : findAgent(active);
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active, currentAgent: currentAgent()?.name, config })}`);
  const saveActive = (ctx: ExtensionContext) => { pi.appendEntry(STATE_ENTRY, { active }); publish(ctx); };
  const activate = async (agent: Agent, ctx: ExtensionContext) => {
    const toolError = agentToolError(pi, agent); if (toolError) { pi.setActiveTools([]); return toolError; }
    if (agent.model.trim()) { const [provider, ...parts] = agent.model.trim().split("/"); const model = ctx.modelRegistry.find(provider, parts.join("/")); if (model) try { await pi.setModel(model); } catch (error) { ctx.ui.notify(`Could not select ${agent.model}: ${error instanceof Error ? error.message : String(error)}`, "warning"); } }
    if (agent.effort.trim()) pi.setThinkingLevel(agent.effort.trim() as any);
    const tools = new Set(agent.tools);
    for (const info of pi.getAllTools()) if (agent.mcpServers.some((server) => info.name.startsWith(`mcp_${safeName(server)}_`))) tools.add(info.name);
    pi.setActiveTools([...tools]); return undefined;
  };
  const activateTarget = async (ctx: ExtensionContext) => {
    if (active === "orchestrator") { activeToolError = undefined; pi.setActiveTools(["call_agent"]); return; }
    const sequence = findSequence(active); const agent = findAgent(run?.sequence.agents[run.index] || sequence?.agents[0] || active);
    activeToolError = agent ? await activate(agent, ctx) : undefined;
  };
  pi.on("resources_discover", () => {
    const agent = currentAgent(); const skillPaths = agent ? agentSkills(agent) : [];
    if (pendingHandoff && run) {
      const handoff = pendingHandoff; const sequence = run.sequence; const index = run.index;
      pendingHandoff = undefined; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index });
      setTimeout(() => pi.sendUserMessage(marker(handoff, sequence, index)), 0);
    }
    return skillPaths.length ? { skillPaths } : undefined;
  });
  pi.on("session_shutdown", () => { delete process.env.PI_DESKTOP_ORCHESTRATION_ACTIVE; });

  const registerTool = () => pi.registerTool({
    name: "call_agent", label: "Call agent or sequence",
    description: `Call one configured agent or sequence. Available:\n${[...config.agents, ...config.sequences].map((item) => `${item.name}: ${item.description || ("agents" in item ? "Sequence" : "Agent")}`).join("\n")}`,
    parameters: Type.Object({ target: Type.String({ description: "Exact agent or sequence name" }), task: Type.String({ description: "Task to pass to it" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const sequence = findSequence(params.target); const names = sequence?.agents ?? [params.target]; let output = params.task;
      for (const name of names) { const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent or sequence: ${params.target}`); const toolError = agentToolError(pi, agent); if (toolError) throw new Error(toolError); onUpdate?.({ content: [{ type: "text", text: `${name} running…` }] }); output = await runChild(agent, output, ctx.cwd, signal); }
      return { content: [{ type: "text", text: output }], details: { target: params.target, agents: names } };
    }
  });
  registerTool();

  pi.registerCommand("pi-orchestration-use", { description: "Select a Pi orchestration agent or sequence", handler: async (args, ctx) => {
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* CLI users may pass a plain name */ }
    if (name !== "orchestrator" && !findAgent(name) && !findSequence(name)) throw new Error(`Unknown orchestration target: ${name}`);
    active = name; run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
  }});
  pi.registerCommand("pi-orchestration-config", { description: "Update Pi orchestration configuration", handler: async (args, ctx) => {
    const next = normalize(decode<Config>(args.trim())); await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); config = next;
    if (active !== "orchestrator" && !findAgent(active) && !findSequence(active)) active = config.agents[0]?.name || "default";
    run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
  }});
  pi.registerCommand("pi-orchestration-next", { description: "Continue an orchestration sequence after reloading its resources", handler: async (args, ctx) => {
    const next = decode<{ sequence: string; index: number; handoff: string }>(args.trim()); const sequence = findSequence(next.sequence);
    if (!sequence || next.index < 0 || next.index >= sequence.agents.length || typeof next.handoff !== "string") throw new Error("Invalid sequence handoff");
    pi.appendEntry(RUN_ENTRY, next); await ctx.reload();
  }});

  pi.on("session_start", async (_event, ctx) => {
    let savedRun: { sequence?: string; index?: number; handoff?: string } | undefined;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom") {
      if (entry.customType === STATE_ENTRY && typeof (entry.data as any)?.active === "string") active = (entry.data as any).active;
      if (entry.customType === RUN_ENTRY) savedRun = entry.data as typeof savedRun;
    }
    if (active !== "orchestrator" && !findAgent(active) && !findSequence(active)) active = config.agents[0]?.name || "default";
    const sequence = typeof savedRun?.sequence === "string" ? findSequence(savedRun.sequence) : undefined; const index = Number(savedRun?.index);
    run = sequence?.name === active && Number.isInteger(index) && index >= 0 && index < sequence.agents.length ? { sequence, index, final: "", failed: false } : undefined;
    pendingHandoff = run && typeof savedRun?.handoff === "string" ? savedRun.handoff : undefined;
    await activateTarget(ctx);
    publish(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/")) return { action: "continue" };
    if (activeToolError) { if (run) pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; }
    if (HANDOFF.test(event.text)) return { action: "continue" };
    const sequence = findSequence(active);
    if (sequence) { run = { sequence, index: 0, final: "", failed: false }; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index: 0 }); const agent = findAgent(sequence.agents[0]); activeToolError = agent ? await activate(agent, ctx) : undefined; if (activeToolError) { pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } return { action: "transform", text: marker(event.text, sequence, 0), images: event.images }; }
    if (active === "orchestrator") { pi.setActiveTools(["call_agent"]); return { action: "continue" }; }
    const agent = findAgent(active); activeToolError = agent ? await activate(agent, ctx) : undefined; if (activeToolError) { ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } return { action: "continue" };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (active === "orchestrator") return { systemPrompt: `${event.systemPrompt}\n\nYou are an orchestrator. Delegate work through call_agent. Do not perform the delegated work yourself.` };
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
    void (async () => { const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-")); try { const branch = join(temporary, "branch.jsonl"); await copyFile(session, branch); let output = current.final; for (const name of background) { const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent: ${name}`); const toolError = agentToolError(pi, agent); if (toolError) throw new Error(toolError); output = await runChild(agent, output, ctx.cwd, undefined, branch); } } catch (error) { ctx.ui.notify(`Background sequence failed: ${error instanceof Error ? error.message : String(error)}`, "error"); } finally { await rm(temporary, { recursive: true, force: true }); } })();
  });
}
