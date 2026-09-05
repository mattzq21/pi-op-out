import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Agent, DefinedAgents } from "../pi-define-agents/index";
type Sequence = { name: string; description: string; agents: string[]; visibleSteps: number };
type Config = { sequences: Sequence[] };
type Run = { sequence: Sequence; index: number; final: string; failed: boolean };
type Delegation = { agent: string; task: string; final: string };
const STATUS_KEY = "pi-desktop-orchestration";
const STATE_ENTRY = "pi-orchestration-state";
const RUN_ENTRY = "pi-orchestration-run";
const DELEGATIONS_ENTRY = "pi-orchestration-delegations";
const PAUSE_ENTRY = "pi-desktop-pause-state";
const SEQUENCE_MARKER_ENTRY = "pi-orchestration-sequence-marker";
const HANDOFF = /^<!-- pi-desktop-sequence:/;
const CHILD_OUTPUT_LIMIT = 4 * 1024 * 1024;
const execFile = promisify(execFileCallback);
const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const fallbackConfig: Config = { sequences: [] };

async function writeConfig(value: Config) {
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, configPath); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function normalize(value: Partial<Config>): Config {
  const sequences = Array.isArray(value.sequences) ? value.sequences.filter((sequence) => sequence && typeof sequence.name === "string" && sequence.name.length > 0 && Array.isArray(sequence.agents) && sequence.agents.length > 0 && sequence.agents.every((name) => typeof name === "string")).map((sequence) => ({ ...sequence, description: sequence.description || "", visibleSteps: Math.max(1, Math.min(sequence.agents.length, Number(sequence.visibleSteps) || sequence.agents.length)) })) : [];
  return { sequences };
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
function multiAgentMode(value: string): "final-only" | "own+final" | undefined { return value === "orchestrator" ? "final-only" : value === "final-only" || value === "own+final" ? value : undefined; }
function isPaused(ctx: ExtensionContext) {
  const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === PAUSE_ENTRY);
  const state = entry?.type === "custom" ? entry.data as { isPaused?: boolean; isPausing?: boolean } | undefined : undefined;
  return state?.isPaused === true || state?.isPausing === true;
}
function piInvocation(args: string[]) {
  const script = process.argv[1];
  return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: process.execPath, args };
}

async function runChild(definitions: DefinedAgents, agent: Agent, task: string, cwd: string, signal?: AbortSignal, session?: string) {
  const child = definitions.child(agent, session);
  const invocation = piInvocation([...child.args, task]);
  try {
    const { stdout } = await execFile(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...child.env },
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
  if (process.env.PI_DEFINE_AGENTS_CHILD) return;
  let config = await loadConfig(); let active = "default"; let run: Run | undefined; let pendingHandoff: string | undefined; let authorizedHandoff: string | undefined; let activeToolError: string | undefined; let originalTask = ""; let delegations: Delegation[] = []; const backgroundControllers = new Set<AbortController>();
  const saveDelegations = () => pi.appendEntry(DELEGATIONS_ENTRY, { originalTask, delegations: [...delegations] });

  let definitions: DefinedAgents | undefined;
  const requireDefinitions = () => { if (!definitions) throw new Error("pi-orchestration requires pi-define-agents. Install and load pi-define-agents, then /reload."); return definitions; };
  const findAgent = (name: string) => definitions?.list().find((agent) => agent.name === name);
  const findSequence = (name: string) => config.sequences.find((sequence) => sequence.name === name);
  const currentAgent = () => multiAgentMode(active) ? undefined : findSequence(active) ? findAgent(run?.sequence.agents[run.index] || findSequence(active)!.agents[0]) : findAgent(active);
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, `json:${encode({ version: 1, active, currentAgent: currentAgent()?.name, config })}`);
  const saveActive = (ctx: ExtensionContext) => { pi.appendEntry(STATE_ENTRY, { active }); publish(ctx); };
  const activate = (agent: Agent, ctx: ExtensionContext) => requireDefinitions().use(agent.name, ctx);
  const activateTarget = async (ctx: ExtensionContext) => {
    if (multiAgentMode(active)) { activeToolError = undefined; pi.setActiveTools(["call_agent"]); return; }
    const sequence = findSequence(active); const agent = findAgent(run?.sequence.agents[run.index] || sequence?.agents[0] || active);
    activeToolError = agent ? await activate(agent, ctx) : `Unknown agent in orchestration target: ${active}`;
    if (activeToolError) pi.setActiveTools([]);
  };
  pi.on("resources_discover", () => {
    if (pendingHandoff && run) {
      const handoff = pendingHandoff; const sequence = run.sequence; const index = run.index;
      pendingHandoff = undefined; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index });
      const message = marker(handoff, sequence, index); authorizedHandoff = message; pi.appendEntry(SEQUENCE_MARKER_ENTRY, { message }); setTimeout(() => pi.sendUserMessage(message), 0);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => { for (const controller of backgroundControllers) controller.abort(); backgroundControllers.clear(); ctx.ui.setStatus(STATUS_KEY, undefined); });


  const registerTool = () => pi.registerTool({
    name: "call_agent", label: "Call agent or sequence",
    description: `Call one configured agent or sequence, or use target "done" when the user's job is complete. Available:\n${[...(definitions?.list() ?? []), ...config.sequences].map((item) => `${item.name}: ${item.description || ("agents" in item ? "Sequence" : "Agent")}`).join("\n")}`,
    parameters: Type.Object({ target: Type.String({ description: "Exact agent or sequence name, or done" }), task: Type.String({ description: "Task to pass to it, or the final answer when done" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      requireDefinitions();
      if (params.target === "done") return { content: [{ type: "text", text: `Job complete. Reply to the user with this final answer:\n\n${params.task}` }], details: { done: true } };
      const sequence = findSequence(params.target); const names = sequence?.agents ?? [params.target]; let output = params.task;
      for (const name of names) {
        const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent or sequence: ${params.target}`); const toolError = requireDefinitions().check(agent); if (toolError) throw new Error(toolError); onUpdate?.({ content: [{ type: "text", text: `${name} running…` }], details: { target: params.target, agents: names } });
        const mode = multiAgentMode(active); const prior = delegations.map((item) => `${mode === "own+final" && item.agent === name ? `[Your request]\n${item.task}\n` : ""}[Final from ${item.agent}]\n${item.final}`).join("\n\n");
        const task = mode ? `[Original user request]\n${originalTask}${prior ? `\n\n${prior}` : ""}\n\n[Your current request]\n${output}` : output;
        const requested = output; output = await runChild(requireDefinitions(), agent, task, ctx.cwd, signal); if (mode) { delegations.push({ agent: name, task: requested, final: output }); saveDelegations(); }
      }
      return { content: [{ type: "text", text: output }], details: { target: params.target, agents: names } };
    }
  });
  const connect = (value: DefinedAgents) => {
    if (value?.version !== 1) return;
    definitions = value;
    value.manage(() => currentAgent()?.name, (name) => { active = name; run = undefined; pi.appendEntry(STATE_ENTRY, { active }); pi.appendEntry(RUN_ENTRY, null); });
    registerTool();
  };
  const unsubscribe = pi.events.on("pi-define-agents:ready", (value) => connect(value as DefinedAgents));
  pi.on("session_shutdown", () => unsubscribe());
  pi.events.emit("pi-define-agents:request", connect);

  pi.registerCommand("pi-orchestration-use", { description: "Select a Pi orchestration agent or sequence", handler: async (args, ctx) => {
    requireDefinitions();
    const argument = args.trim(); let name = argument; try { const decoded = decode<unknown>(argument); if (typeof decoded === "string") name = decoded; } catch { /* CLI users may pass a plain name */ }
    if (!multiAgentMode(name) && !findAgent(name) && !findSequence(name)) throw new Error(`Unknown orchestration target: ${name}`);
    active = name; run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
  }});
  pi.registerCommand("pi-orchestration-config", { description: "Update Pi orchestration configuration", handler: async (args, ctx) => {
    requireDefinitions();
    const next = normalize(decode<Config>(args.trim())); const previous = config; const previousActive = active;
    for (const sequence of next.sequences) {
      if (findAgent(sequence.name) || multiAgentMode(sequence.name) || sequence.name === "done") throw new Error(`Sequence name is reserved: ${sequence.name}`);
      for (const name of sequence.agents) if (!findAgent(name)) throw new Error(`Sequence "${sequence.name}" requires undefined agent "${name}"`);
    }
    await writeConfig(next); config = next;
    try {
      if (!multiAgentMode(active) && !findAgent(active) && !findSequence(active)) active = "default";
      run = undefined; pi.appendEntry(RUN_ENTRY, null); saveActive(ctx); await ctx.reload();
    } catch (error) { await writeConfig(previous); config = previous; active = previousActive; throw error; }
  }});
  pi.registerCommand("pi-orchestration-next", { description: "Continue an orchestration sequence after reloading its resources", handler: async (args, ctx) => {
    requireDefinitions();
    const next = decode<{ sequence: string; index: number; handoff: string }>(args.trim()); const sequence = findSequence(next.sequence);
    if (!sequence || next.index < 0 || next.index >= sequence.agents.length || typeof next.handoff !== "string") throw new Error("Invalid sequence handoff");
    pi.appendEntry(RUN_ENTRY, next); await ctx.reload();
  }});
  pi.on("session_start", async (_event, ctx) => {
    if (!definitions) { ctx.ui.setStatus(STATUS_KEY, undefined); ctx.ui.notify("pi-orchestration is disabled: install and load pi-define-agents, then /reload.", "error"); return; }
    originalTask = ""; delegations = [];
    let savedRun: { sequence?: string; index?: number; handoff?: string } | undefined;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom") {
      if ((entry.customType === STATE_ENTRY || entry.customType === "pi-define-agents-state") && typeof (entry.data as any)?.active === "string") active = (entry.data as any).active;
      if (entry.customType === RUN_ENTRY) savedRun = entry.data as typeof savedRun;
      if (entry.customType === DELEGATIONS_ENTRY) {
        const saved = entry.data as { originalTask?: unknown; delegations?: unknown } | undefined;
        originalTask = typeof saved?.originalTask === "string" ? saved.originalTask : "";
        delegations = Array.isArray(saved?.delegations) ? saved.delegations.filter((item): item is Delegation => Boolean(item) && typeof item.agent === "string" && typeof item.task === "string" && typeof item.final === "string") : [];
      }
    }
    if (active === "orchestrator") active = "final-only";
    if (!multiAgentMode(active) && !findAgent(active) && !findSequence(active)) active = "default";
    const sequence = typeof savedRun?.sequence === "string" ? findSequence(savedRun.sequence) : undefined; const index = Number(savedRun?.index);
    run = sequence?.name === active && Number.isInteger(index) && index >= 0 && index < sequence.agents.length ? { sequence, index, final: "", failed: false } : undefined;
    pendingHandoff = run && typeof savedRun?.handoff === "string" ? savedRun.handoff : undefined;
    await activateTarget(ctx);
    publish(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (!definitions || event.text.startsWith("/")) return { action: "continue" };
    if (activeToolError) { if (run) pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; }
    if (HANDOFF.test(event.text)) { if (event.text === authorizedHandoff) { authorizedHandoff = undefined; return { action: "continue" }; } return { action: "transform", text: event.text.replace("<!-- pi-desktop-sequence:", "<!-- user-text-pi-desktop-sequence:"), images: event.images }; }
    const text = event.text;
    const sequence = findSequence(active);
    if (sequence) { run = { sequence, index: 0, final: "", failed: false }; pi.appendEntry(RUN_ENTRY, { sequence: sequence.name, index: 0 }); const agent = findAgent(sequence.agents[0]); activeToolError = agent ? await activate(agent, ctx) : `Unknown agent in orchestration target: ${active}`; if (activeToolError) { pi.appendEntry(RUN_ENTRY, null); run = undefined; ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } const marked = marker(text, sequence, 0); pi.appendEntry(SEQUENCE_MARKER_ENTRY, { message: marked }); return { action: "transform", text: marked, images: event.images }; }
    if (multiAgentMode(active)) { originalTask = text; delegations = []; saveDelegations(); pi.setActiveTools(["call_agent"]); return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images }; }
    const agent = findAgent(active); activeToolError = agent ? await activate(agent, ctx) : `Unknown agent in orchestration target: ${active}`; if (activeToolError) { ctx.ui.notify(activeToolError, "error"); return { action: "handled" }; } return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images };
  });
  pi.on("before_agent_start", async (event) => {
    if (!definitions) return;
    if (multiAgentMode(active)) { const agentsMd = findAgent("default")?.agentsMd.trim(); return { systemPrompt: `${event.systemPrompt}\n\nYou are an ephemeral orchestrator. Delegate every pass through call_agent. Call another agent until the job is complete, then call target "done" and answer the user. Agents receive ${multiAgentMode(active) === "final-only" ? "only the original request and chronological final messages" : "their own requests plus every chronological final message"}.${agentsMd ? `\n\n# AGENTS.md\n\n${agentsMd}` : ""}` }; }
  });
  pi.on("agent_end", (event, ctx) => { if (run && !isPaused(ctx)) { const result = finalText(event.messages as any[]); run.final = result.text; run.failed = result.failed; } });
  pi.on("agent_settled", async (_event, ctx) => {
    if (isPaused(ctx)) return;
    const current = run; if (!current || current.failed || !current.final) { if (current) pi.appendEntry(RUN_ENTRY, null); run = undefined; return; }
    const nextIndex = current.index + 1; const visible = Math.min(Math.max(1, current.sequence.visibleSteps), current.sequence.agents.length);
    if (nextIndex < visible) { const handoff = { sequence: current.sequence.name, index: nextIndex, handoff: current.final }; run = undefined; pi.sendUserMessage(`/pi-orchestration-next ${encode(handoff)}`, { expandPromptTemplates: true }); return; }
    pi.appendEntry(RUN_ENTRY, null); run = undefined;
    const background = current.sequence.agents.slice(visible); if (!background.length) return;
    const session = ctx.sessionManager.getSessionFile(); if (!session) { ctx.ui.notify("Background sequence requires a persisted session", "error"); return; }
    const controller = new AbortController(); backgroundControllers.add(controller);
    void (async () => { const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-")); try { const branch = join(temporary, "branch.jsonl"); await copyFile(session, branch); let output = current.final; for (const name of background) { const agent = findAgent(name); if (!agent) throw new Error(`Unknown agent: ${name}`); const toolError = requireDefinitions().check(agent); if (toolError) throw new Error(toolError); output = await runChild(requireDefinitions(), agent, output, ctx.cwd, controller.signal, branch); } } catch (error) { if (!controller.signal.aborted) ctx.ui.notify(`Background sequence failed: ${error instanceof Error ? error.message : String(error)}`, "error"); } finally { backgroundControllers.delete(controller); await rm(temporary, { recursive: true, force: true }); } })();
  });
}
