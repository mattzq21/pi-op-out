import { NativeWorkflowAgent, WorkflowLimitError } from "./nativeAgent";
import { ImplementReviewWorkflow } from "./implementReview";
import { validateWorkflowOptions, type AgentRole, type Workflow, type WorkflowBlock, type WorkflowContext, type WorkflowOptions, type WorkflowRun } from "./model";

const STORAGE_KEY = "piop-workflow-runs-v1";

function savedRuns(): WorkflowRun[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as WorkflowRun[];
    if (!Array.isArray(saved)) return [];
    return saved.filter((run) => run.definition === "implement-review" && run.options?.limits && Array.isArray(run.blocks)).map((run) => run.status === "running"
      ? { ...run, status: "interrupted", finishedAt: Date.now(), message: "The workflow window closed before completion. Start a new run to continue.", blocks: run.blocks.map((block) => block.status === "running" ? { ...block, status: "failed", output: "Interrupted when the workflow window closed." } : block) }
      : run);
  } catch { return []; }
}

class WorkflowExecution implements WorkflowContext {
  private readonly controller = new AbortController();
  private readonly agents = new Set<NativeWorkflowAgent>();
  private implementer?: NativeWorkflowAgent;
  readonly options: WorkflowOptions;
  constructor(readonly run: WorkflowRun, private readonly changed: () => void) { this.options = run.options; }

  iteration(value: number) { this.check(); this.run.iteration = value; this.changed(); }
  private check() {
    this.controller.signal.throwIfAborted();
    if (this.run.cost >= this.options.limits.cost) throw new WorkflowLimitError("Workflow cost limit reached (API prices).");
  }
  private block(nodeId: string, input: string) {
    this.check();
    const block: WorkflowBlock = { id: crypto.randomUUID(), nodeId, iteration: this.run.iteration, status: "running", startedAt: Date.now(), input };
    this.run.blocks.push(block); this.changed(); return block;
  }
  private complete(block: WorkflowBlock, output: string) { block.status = "completed"; block.finishedAt = Date.now(); block.output = output; this.changed(); }
  private failed(block: WorkflowBlock, reason: unknown) { block.status = "failed"; block.finishedAt = Date.now(); block.output = String(reason); this.changed(); }

  async agent(nodeId: string, role: AgentRole, prompt: string) {
    const block = this.block(nodeId, prompt);
    const agent = role === "implementer" ? this.implementer ??= new NativeWorkflowAgent(this.options, this.run.id, role) : new NativeWorkflowAgent(this.options, this.run.id, role);
    this.agents.add(agent);
    const timeout = setTimeout(() => this.controller.abort(new WorkflowLimitError("Workflow agent time limit reached.")), this.options.limits.minutes * 60000);
    try {
      const result = await agent.run(block.id, prompt, this.options.limits.cost - this.run.cost, this.controller.signal, (cost) => {
        this.run.cost += cost; this.changed();
        if (this.run.cost >= this.options.limits.cost) this.controller.abort(new WorkflowLimitError("Workflow cost limit reached (API prices)."));
      }, (state) => { block.sessionId = state.sessionId; block.sessionPath = state.sessionFile; this.changed(); });
      this.check();
      this.complete(block, [result.summary, ...result.findings].join("\n\n"));
      return result;
    } catch (error) { this.failed(block, error); throw error; }
    finally {
      clearTimeout(timeout);
      if (role === "reviewer") { await agent.stop(); await agent.dispose(); this.agents.delete(agent); }
    }
  }

  async snapshot(nodeId: string) {
    const block = this.block(nodeId, "Collect the original prompt checkpoint and all implementer response snapshots.");
    try {
      if (!this.implementer) throw new Error("No implementation session exists");
      const snapshot = await this.implementer.snapshots(this.controller.signal);
      this.complete(block, JSON.stringify(snapshot, null, 2)); return snapshot;
    } catch (error) { this.failed(block, error); throw error; }
  }
  decision(nodeId: string, message: string) { this.complete(this.block(nodeId, "Evaluate review findings and remaining iterations."), message); }
  finish(status: "completed" | "limited", message: string) {
    this.complete(this.block("done", "Finish workflow."), message);
    this.run.status = status; this.run.message = message; this.run.finishedAt = Date.now(); this.changed();
  }
  cancel() { this.controller.abort(new Error("Workflow cancelled by the user.")); for (const agent of this.agents) void agent.stop(); }
  async execute(definition: Workflow) {
    try { await definition.execute(this); }
    catch (error) {
      const reason = this.controller.signal.aborted ? this.controller.signal.reason : error;
      this.run.status = reason instanceof WorkflowLimitError ? "limited" : this.controller.signal.aborted ? "cancelled" : "failed";
      this.run.message = reason instanceof Error ? reason.message : String(reason); this.run.finishedAt = Date.now(); this.changed();
    } finally {
      await Promise.allSettled([...this.agents].map(async (agent) => { await agent.stop(); await agent.dispose(); }));
      this.agents.clear();
    }
  }
}

export class WorkflowManager {
  readonly definition = new ImplementReviewWorkflow();
  private runs = savedRuns();
  private readonly active = new Map<string, WorkflowExecution>();
  private readonly listeners = new Set<() => void>();
  storageError?: string;
  list() { return structuredClone(this.runs); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish = () => {
    this.runs = [...this.runs];
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.runs)); this.storageError = undefined; }
    catch { this.storageError = "Workflow history could not be saved in this window's storage."; }
    for (const listener of this.listeners) listener();
  };
  start(options: WorkflowOptions) {
    const issue = this.definition.inputIssue(options);
    if (issue) throw new Error(issue.message);
    validateWorkflowOptions(options);
    if (this.runs.some((run) => run.status === "running" && run.options.cwd === options.cwd && run.options.hostId === options.hostId)) throw new Error("A workflow is already running in this project. Wait for it or stop it first.");
    const run: WorkflowRun = { id: crypto.randomUUID(), name: options.intent.trim().slice(0, 70), definition: this.definition.id, options: structuredClone(options), status: "running", startedAt: Date.now(), cost: 0, iteration: 0, blocks: [] };
    this.runs.unshift(run);
    const execution = new WorkflowExecution(run, this.publish); this.active.set(run.id, execution); this.publish();
    void execution.execute(this.definition).finally(() => this.active.delete(run.id));
    return run.id;
  }
  cancel(id: string) { this.active.get(id)?.cancel(); }
  dispose() { for (const execution of this.active.values()) execution.cancel(); }
}
