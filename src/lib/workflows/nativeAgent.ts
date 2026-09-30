import type { AgentState, RpcEvent } from "../../types";
import { textOf } from "../content";
import type { PiEntry } from "../messages";
import { NativeTransport } from "../nativeTransport";
import type { AgentResult, AgentRole, ReviewSnapshot, WorkflowOptions } from "./model";

export class WorkflowLimitError extends Error {}

function control<T>(transport: NativeTransport, request: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let unsubscribe = () => {};
    const finish = (error?: unknown, data?: T) => { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(data!); };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Workflow control request timed out")), 30000);
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = transport.subscribe((event) => {
      if (event.type !== "extension_ui_request" || event.statusKey !== "piop-workflow-control" || typeof event.statusText !== "string") return;
      try {
        const reply = JSON.parse(event.statusText.slice(5));
        if (reply.id === id) finish(reply.error ? new Error(reply.error) : undefined, reply.data);
      } catch { finish(new Error("Invalid workflow control response")); }
    });
    void transport.command({ type: "prompt", message: `/piop-workflow ${JSON.stringify({ ...request, id })}` }).catch((error) => finish(error));
  });
}

function eventCost(event: RpcEvent) {
  if (event.type !== "message_end") return 0;
  const message = event.message as { role?: string; usage?: { cost?: { total?: number } } } | undefined;
  const cost = message?.usage?.cost?.total;
  return message?.role === "assistant" && typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function failureEvent(event: RpcEvent) {
  if (event.type === "disconnected" || event.type === "ownership_lost") return new Error("Workflow agent disconnected or lost ownership.");
  if (event.type === "extension_ui_request" && ["select", "input", "confirm", "editor", "custom"].includes(String(event.method))) return new Error("Workflow agent requires user input. Inspect its session and start a new workflow after resolving it.");
  if (event.type === "extension_ui_request" && event.statusKey === "piop-input-rejected") return new Error(`Workflow prompt rejected: ${String(event.statusText)}`);
  return undefined;
}

function runPrompt(transport: NativeTransport, prompt: string, signal: AbortSignal, onCost: (cost: number) => void) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let started = false;
    let unsubscribe = () => {};
    const finish = (error?: unknown) => { unsubscribe(); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
    const abort = () => { void transport.command({ type: "abort" }).catch(() => undefined); finish(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = transport.subscribe((event) => {
      const cost = eventCost(event); if (cost) onCost(cost);
      if (event.type === "agent_start") started = true;
      const failure = failureEvent(event);
      if (failure) { void transport.command({ type: "abort" }).catch(() => undefined); finish(failure); }
      else if (started && event.type === "agent_settled") finish();
    });
    void transport.command({ type: "prompt", message: prompt }).catch((error) => finish(error));
  });
}

function reportedResult(entries: PiEntry[], stepId: string): AgentResult | undefined {
  const saved = entries.filter((entry) => entry.type === "custom" && entry.customType === "piop-workflow-result" && (entry.data as { stepId?: string })?.stepId === stepId).at(-1);
  const result = saved?.data as { outcome: string; summary: string; findings: string[] } | undefined;
  if (result?.outcome === "limited") throw new WorkflowLimitError(result.summary);
  if (result?.outcome === "failed") throw new Error(result.summary);
  if (result?.outcome === "complete" || result?.outcome === "handoff") return { summary: result.summary, findings: result.findings };
  return undefined;
}

function agentResult(entries: PiEntry[], stepId: string, role: AgentRole): AgentResult {
  const result = reportedResult(entries, stepId);
  const last = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)?.message;
  if (last?.stopReason === "error") throw new Error(last.errorMessage);
  if (result) return result;
  if (last?.stopReason === "aborted") throw new Error("Workflow agent was stopped before completing its step.");
  if (role === "reviewer") throw new Error("Reviewer stopped without calling workflow_handoff. The workflow cannot treat this as a clean review.");
  if (!last || last.stopReason !== "stop") throw new Error("Implementer did not finish successfully.");
  return { summary: textOf(last.content), findings: [] };
}

export class NativeWorkflowAgent {
  readonly transport: NativeTransport;
  private configured = false;
  constructor(readonly options: WorkflowOptions, readonly workflowId: string, readonly role: AgentRole) {
    this.transport = new NativeTransport({ cwd: options.cwd, hostId: options.hostId });
  }

  async run(stepId: string, prompt: string, allowance: number, signal: AbortSignal, onCost: (cost: number) => void, onSession: (state: AgentState) => void) {
    await this.transport.connect(); signal.throwIfAborted();
    if (!this.transport.ownsConversation()) throw new Error("Workflow could not acquire its agent session.");
    if (!this.configured) {
      if (!await this.transport.isGitRepository()) throw new Error("This workflow requires a Git project.");
      if (this.options.model) await this.transport.command({ type: "set_model", provider: this.options.model.provider, modelId: this.options.model.id });
      await this.transport.command({ type: "set_thinking_level", level: this.options.thinking });
      await this.transport.command({ type: "set_auto_retry", enabled: false });
      await this.transport.command({ type: "set_auto_compaction", enabled: true });
      await this.transport.command({ type: "set_session_name", name: `Workflow ${this.role} · ${this.options.intent.slice(0, 60)}` });
      this.configured = true;
    }
    signal.throwIfAborted();
    await control(this.transport, { action: "configure", config: { workflowId: this.workflowId, stepId, role: this.role, allowance, maxTurns: this.options.limits.turns, deadline: Date.now() + this.options.limits.minutes * 60000 } }, signal);
    onSession(await this.transport.command<AgentState>({ type: "get_state" }));
    await runPrompt(this.transport, prompt, signal, onCost);
    signal.throwIfAborted();
    onSession(await this.transport.command<AgentState>({ type: "get_state" }));
    const { entries } = await this.transport.command<{ entries: PiEntry[] }>({ type: "get_entries" });
    return agentResult(entries, stepId, this.role);
  }

  snapshots(signal: AbortSignal) { return control<ReviewSnapshot>(this.transport, { action: "snapshots", workflowId: this.workflowId }, signal); }
  async stop() { await this.transport.command({ type: "abort" }).catch(() => undefined); }
  async dispose() {
    if (this.configured) await control(this.transport, { action: "release", workflowId: this.workflowId }, AbortSignal.timeout(5000)).catch(() => undefined);
    await this.transport.dispose();
  }
}
