import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "piop-workflow-agent";
const RESULT = "piop-workflow-result";
const STATUS = "piop-workflow-control";
const git = promisify(execFile);
type Config = { workflowId: string; stepId: string; role: "implementer" | "reviewer"; allowance: number; maxTurns: number; deadline: number; startCost: number };
type Outcome = { outcome: "complete" | "failed" | "handoff" | "limited"; summary: string; findings: string[] };

function cost(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch().reduce((sum, entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return sum;
    const value = entry.message.usage.cost.total;
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function bounded(value: number, min: number, max: number) { return Number.isFinite(value) && value >= min && value <= max; }

function configuration(value: unknown, ctx: ExtensionContext): Config {
  const config = value as Config;
  if (!config) throw new Error("Missing workflow configuration");
  if (![config.workflowId, config.stepId].every((id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(id))) throw new Error("Invalid workflow identity");
  if (!["implementer", "reviewer"].includes(config.role)) throw new Error("Invalid workflow agent role");
  if (!bounded(config.allowance, Number.MIN_VALUE, 100000)) throw new Error("Invalid workflow cost allowance");
  if (!Number.isInteger(config.maxTurns) || !bounded(config.maxTurns, 1, 1000)) throw new Error("Invalid workflow turn limit");
  if (!bounded(config.deadline, Date.now() + 1, Date.now() + 86400000)) throw new Error("Invalid workflow deadline");
  return { ...config, startCost: cost(ctx) };
}

async function snapshots(ctx: ExtensionContext, config: Config) {
  const branch = ctx.sessionManager.getBranch();
  const prompt = branch.find((entry) => entry.type === "custom" && entry.customType === "pi-project-prompt-checkpoint");
  const base = prompt?.type === "custom" ? (prompt.data as { commit?: string }).commit : undefined;
  const saved = branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot");
  const data = saved.map((entry) => (entry as { data: { commit?: string; repositoryRoot?: string; unavailable?: boolean } }).data);
  const latest = data.at(-1);
  if (!base || !latest?.commit || latest.unavailable) throw new Error("The implementer did not produce a complete Git checkpoint; review cannot start.");
  const repositoryRoot = latest.repositoryRoot;
  if (!repositoryRoot) throw new Error("Missing checkpoint repository");
  const snapshots = data.map((item) => item.commit).filter((value): value is string => Boolean(value));
  if (![base, ...snapshots].every((value) => /^[a-f0-9]{40,64}$/.test(value))) throw new Error("Invalid Git checkpoint identity");
  const history = await git("git", ["-C", repositoryRoot, "rev-list", "--reverse", `${base}..${latest.commit}`], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const commits = [...new Set([...history.stdout.trim().split("\n").filter(Boolean), ...snapshots])];
  const all = [base, ...commits];
  for (const commit of all) await git("git", ["-C", repositoryRoot, "update-ref", `refs/piop-workflows/${config.workflowId}/${commit}`, commit], { timeout: 10000 });
  return { base, head: latest.commit, commits, repositoryRoot };
}

export default function workflowAgent(pi: ExtensionAPI) {
  let config: Config | undefined;
  let outcome: Outcome | undefined;
  let turns = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTools = pi.events.on("piop:workflow-tools", (value) => {
    const request = value as { tools: string[] };
    if (config) request.tools.push("workflow_goal", ...(config.role === "reviewer" ? ["workflow_handoff"] : []));
  });
  const record = (value: Outcome) => {
    outcome = value;
    pi.appendEntry(RESULT, { ...value, stepId: config!.stepId });
  };
  const limit = (ctx: ExtensionContext) => {
    if (!config) return undefined;
    if (cost(ctx) - config.startCost >= config.allowance) return "Workflow cost limit reached (API prices).";
    if (Date.now() >= config.deadline) return "Workflow time limit reached.";
    return undefined;
  };
  const stopAtLimit = (ctx: ExtensionContext, reason: string) => {
    record({ outcome: "limited", summary: reason, findings: [] });
    ctx.abort();
  };
  const restore = (ctx: ExtensionContext) => {
    clearTimeout(timer); config = undefined; outcome = undefined; turns = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY) config = entry.data ? entry.data as Config : undefined;
    }
    if (config) outcome = { outcome: "failed", summary: "Workflow agent reconnected. Start a new workflow to continue safely.", findings: [] };
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { clearTimeout(timer); stopTools(); });
  pi.on("agent_settled", () => clearTimeout(timer));
  pi.on("turn_start", (_event, ctx) => {
    if (!config) return;
    const reason = limit(ctx) ?? (++turns > config.maxTurns ? "Workflow agent turn limit reached." : undefined);
    if (reason) stopAtLimit(ctx, reason);
  });
  pi.on("input", (_event, ctx) => {
    if (!config) return;
    const reason = limit(ctx) ?? outcome?.summary;
    if (reason) { ctx.ui.notify(reason, "warning"); return { action: "handled" }; }
  });
  pi.on("tool_call", (_event, ctx) => {
    if (!config) return;
    const reason = limit(ctx);
    if (reason) record({ outcome: "limited", summary: reason, findings: [] });
    if (outcome) return { block: true, terminate: true, reason: outcome.summary };
  });
  pi.on("tool_result", (_event, ctx) => { if (outcome) ctx.abort(); });
  pi.registerCommand("piop-workflow", {
    description: "Configure a Piop workflow agent or collect its checkpoints",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args); id = request.id;
        if (typeof id !== "string" || ctx.mode !== "rpc") throw new Error("Invalid workflow request");
        let data: unknown;
        if (request.action === "configure") {
          config = configuration(request.config, ctx); outcome = undefined; turns = 0;
          clearTimeout(timer);
          pi.appendEntry(ENTRY, config);
          timer = setTimeout(() => stopAtLimit(ctx, "Workflow time limit reached."), config.deadline - Date.now());
          data = { configured: true };
        } else {
          if (!config || config.workflowId !== request.workflowId) throw new Error("Workflow agent identity does not match");
          if (request.action === "release") {
            clearTimeout(timer); config = undefined; outcome = undefined;
            pi.appendEntry(ENTRY, null);
            pi.setActiveTools(pi.getActiveTools().filter((name) => !["workflow_goal", "workflow_handoff"].includes(name)));
            data = { released: true };
          } else {
            if (request.action !== "snapshots") throw new Error("Unknown workflow action");
            data = await snapshots(ctx, config);
          }
        }
        ctx.ui.setStatus(STATUS, `json:${JSON.stringify({ id, data })}`);
      } catch (error) {
        ctx.ui.setStatus(STATUS, `json:${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}`);
      }
    },
  });
  pi.registerTool({
    name: "workflow_goal", label: "Workflow goal",
    description: "For a Piop workflow: set the implementation goal, report completion, or report failure. Completing or failing hands control back to the workflow. Use fail for a blocked or incomplete task.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("set"), Type.Literal("complete"), Type.Literal("fail")]), summary: Type.String({ minLength: 1, maxLength: 20000 }) }),
    async execute(_id, params) {
      if (!config) throw new Error("This session is not a workflow agent");
      if (outcome) throw new Error("This workflow step already finished");
      if (params.action === "complete" && config.role !== "implementer") throw new Error("Reviewers must finish with workflow_handoff");
      if (params.action === "set") pi.appendEntry("piop-workflow-goal", { stepId: config.stepId, summary: params.summary });
      else record({ outcome: params.action === "fail" ? "failed" : "complete", summary: params.summary, findings: [] });
      return { content: [{ type: "text", text: params.action === "set" ? "Goal set. Continue working." : "Recorded. Stop now; the workflow will take over." }], details: {} };
    },
  });
  pi.registerTool({
    name: "workflow_handoff", label: "Hand review to implementer",
    description: "Finish a Piop review and hand all findings back to the workflow. Provide an empty findings array only when the review found no issues. Call once after completing the review, then stop.",
    parameters: Type.Object({ findings: Type.Array(Type.String({ minLength: 1, maxLength: 10000 }), { maxItems: 100 }), summary: Type.String({ minLength: 1, maxLength: 20000 }) }),
    async execute(_id, params) {
      if (config?.role !== "reviewer") throw new Error("Only a workflow reviewer can hand off findings");
      if (outcome) throw new Error("This workflow step already finished");
      record({ outcome: "handoff", ...params });
      return { content: [{ type: "text", text: "Review handed off. Stop now; the workflow will take over." }], details: {} };
    },
  });
}
