export type WorkflowStatus = "running" | "completed" | "limited" | "failed" | "cancelled" | "interrupted";
export type BlockStatus = "running" | "completed" | "failed";
export type AgentRole = "implementer" | "reviewer";
export interface WorkflowLimits { cost: number; iterations: number; turns: number; minutes: number; }
export interface WorkflowOptions { intent: string; cwd: string; hostId: string; model?: { provider: string; id: string }; thinking: string; limits: WorkflowLimits; }
export type WorkflowInput = { key: "intent"; type: "textarea"; label: string; placeholder?: string; required?: boolean; default: string } | { key: keyof WorkflowLimits; type: "number"; label: string; min: number; max: number; step: number; default: number };
export interface WorkflowNode { id: string; label: string; kind: "agent" | "snapshot" | "decision" | "finish"; description: string; inputs?: readonly WorkflowInput[]; }
export interface WorkflowEdge { from: string; to: string; label?: string; }
export interface WorkflowBlock { id: string; nodeId: string; iteration: number; status: BlockStatus; startedAt: number; finishedAt?: number; input: string; output?: string; sessionId?: string; sessionPath?: string; }
export interface WorkflowRun { id: string; name: string; definition: string; options: WorkflowOptions; status: WorkflowStatus; startedAt: number; finishedAt?: number; cost: number; iteration: number; blocks: WorkflowBlock[]; message?: string; }
export interface ReviewSnapshot { base: string; head: string; commits: string[]; repositoryRoot: string; }
export interface AgentResult { summary: string; findings: string[]; }
export interface WorkflowContext {
  readonly options: WorkflowOptions;
  iteration(value: number): void;
  agent(nodeId: string, role: AgentRole, prompt: string): Promise<AgentResult>;
  snapshot(nodeId: string): Promise<ReviewSnapshot>;
  decision(nodeId: string, message: string): void;
  finish(status: "completed" | "limited", message: string): void;
}

export abstract class Workflow {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly nodes: readonly WorkflowNode[];
  abstract readonly edges: readonly WorkflowEdge[];
  readonly inputs: readonly WorkflowInput[] = [];
  abstract execute(context: WorkflowContext): Promise<void>;

  inputIssue(options: WorkflowOptions) {
    const groups = [{ id: "config", inputs: this.inputs }, ...this.nodes];
    for (const group of groups) for (const input of group.inputs ?? []) {
      const message = workflowInputError(input, options);
      if (message) return { nodeId: group.id, message };
    }
    return undefined;
  }

  defaultOptions(defaults: Omit<WorkflowOptions, "intent" | "limits">): WorkflowOptions {
    const options: WorkflowOptions = { ...defaults, intent: "", limits: {} as WorkflowLimits };
    for (const input of [...this.inputs, ...this.nodes.flatMap((node) => node.inputs ?? [])]) {
      if (input.type === "textarea") options.intent = input.default;
      else options.limits[input.key] = input.default;
    }
    return options;
  }

  mermaid(run?: WorkflowRun) {
    const nodes = this.nodes.map((node) => {
      const label = node.label.replace(/[^a-zA-Z0-9 ,.?()-]/g, "");
      return node.kind === "decision" ? `  ${node.id}{"${label}"}` : `  ${node.id}["${label}"]`;
    });
    const edges = this.edges.map((edge) => `  ${edge.from} -->${edge.label ? `|${edge.label}|` : ""} ${edge.to}`);
    const classes = this.nodes.flatMap((node) => {
      const block = run?.blocks.filter((block) => block.nodeId === node.id).at(-1);
      return [`  class ${node.id} wf-${node.id}${block ? `,${block.status}` : ""}`];
    });
    return ["flowchart TD", ...nodes, ...edges, ...classes, "  classDef running stroke:#79b8ff,stroke-width:3px", "  classDef completed stroke:#73c991,stroke-width:2px", "  classDef failed stroke:#f48771,stroke-width:3px"].join("\n");
  }
}

function workflowInputError(input: WorkflowInput, options: WorkflowOptions) {
  if (input.type === "textarea") return input.required && !options.intent.trim() ? `${input.label} is required.` : undefined;
  const value = options.limits[input.key];
  if (!Number.isFinite(value) || value < input.min || value > input.max) return `${input.label} must be between ${input.min} and ${input.max}.`;
  const steps = (value - input.min) / input.step;
  if (Math.abs(steps - Math.round(steps)) > 0.000001) return `${input.label} must use increments of ${input.step}.`;
  return undefined;
}

export function validateWorkflowOptions(options: WorkflowOptions) {
  if (!options.intent.trim() || !options.cwd.trim()) throw new Error("Choose a project and describe the implementation goal.");
  const bounds: Array<[keyof WorkflowLimits, number, number]> = [["cost", 0.01, 100000], ["iterations", 1, 5], ["turns", 1, 1000], ["minutes", 1, 1440]];
  for (const [key, min, max] of bounds) {
    const value = options.limits[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    if (key !== "cost" && !Number.isInteger(value)) throw new Error(`${key} must be a whole number.`);
  }
}
