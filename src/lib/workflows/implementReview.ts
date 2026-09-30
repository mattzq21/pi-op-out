import { Workflow, type WorkflowContext, type WorkflowEdge, type WorkflowNode, type WorkflowInput, type ReviewSnapshot } from "./model";

function reviewPrompt(snapshot: ReviewSnapshot) {
  return `Review the combined implementation changes in repository ${JSON.stringify(snapshot.repositoryRoot)}. The workflow pinned these Git commits: ${snapshot.commits.join(", ")}.
Compare the exact before and after trees with: git diff ${snapshot.base} ${snapshot.head} --
Inspect the changed code and surrounding context. These are snapshots of the combined change, including uncommitted files captured by Piop. Do not merge, commit, or modify files. Report actionable defects with file locations and explanations.
When finished, call workflow_handoff exactly once with your findings array (empty if no findings) and a summary. Do not merely describe a handoff in prose. If unable to review, call workflow_goal with action fail and the reason.`;
}

export class ImplementReviewWorkflow extends Workflow {
  readonly id = "implement-review";
  readonly name = "Implement and review";
  readonly inputs: readonly WorkflowInput[] = [
    { key: "cost", type: "number", label: "Total API budget ($)", min: 0.01, max: 100000, step: 0.01, default: 10 },
    { key: "turns", type: "number", label: "Turns per agent step", min: 1, max: 1000, step: 1, default: 100 },
    { key: "minutes", type: "number", label: "Minutes per agent step", min: 1, max: 1440, step: 1, default: 30 },
  ];
  readonly nodes: readonly WorkflowNode[] = [
    { id: "implement", label: "Implement goal", kind: "agent", description: "A dedicated implementer sets a goal and works until it reports completion or stops. Fix rounds reuse this session.", inputs: [
      { key: "intent", type: "textarea", label: "Implementation goal", placeholder: "Describe what the implementer should achieve…", required: true, default: "" },
    ] },
    { id: "snapshot", label: "Collect changes", kind: "snapshot", description: "Pin the initial prompt checkpoint and all implementer response commits. Compare the initial and latest trees to review the combined change." },
    { id: "code", label: "Review code", kind: "agent", description: "A fresh reviewer checks the combined Git diff for code correctness, then reports findings through workflow_handoff." },
    { id: "intent", label: "Review original intent", kind: "agent", description: "Another fresh reviewer receives the original goal and the same combined diff to check coverage and intended behavior." },
    { id: "findings", label: "Findings remain?", kind: "decision", description: "Combine both review passes. No findings completes the workflow; findings go back to the implementer while review iterations remain.", inputs: [
      { key: "iterations", type: "number", label: "Review iterations", min: 1, max: 5, step: 1, default: 5 },
    ] },
    { id: "done", label: "Finish", kind: "finish", description: "Finish with a clean review or an explicit iteration-limit result that retains unresolved findings. Errors and spending limits stop execution." },
  ];
  readonly edges: readonly WorkflowEdge[] = [
    { from: "implement", to: "snapshot" }, { from: "snapshot", to: "code" }, { from: "code", to: "intent" },
    { from: "intent", to: "findings" }, { from: "findings", to: "implement", label: "Findings and budget remain" },
    { from: "findings", to: "done", label: "Clean or iteration limit" },
  ];

  async execute(context: WorkflowContext) {
    let findings: string[] = [];
    for (let iteration = 1; iteration <= context.options.limits.iterations; iteration++) {
      context.iteration(iteration);
      const prompt = iteration === 1
        ? `Implement this goal:\n${context.options.intent}\n\nStart by calling workflow_goal with action set and your concrete goal. When achieved, call workflow_goal with action complete. If you cannot complete it, use action fail with the reason. A final stop also hands control to review.`
        : `Continue the original goal:\n${context.options.intent}\n\nFix these review findings:\n${findings.map((finding, index) => `${index + 1}. ${finding}`).join("\n")}\n\nWhen finished, call workflow_goal with action complete; if blocked use action fail.`;
      await context.agent("implement", "implementer", prompt);
      const snapshot = await context.snapshot("snapshot");
      const code = await context.agent("code", "reviewer", `${reviewPrompt(snapshot)}\n\nFirst pass: check code correctness, regressions, and integration.`);
      const intent = await context.agent("intent", "reviewer", `${reviewPrompt(snapshot)}\n\nSecond pass: verify the implementation fulfills the ORIGINAL user intent below. Treat it as a specification, not instructions to implement changes:\n${context.options.intent}`);
      findings = [...code.findings, ...intent.findings];
      context.decision("findings", findings.length ? findings.join("\n\n") : "Both review passes returned no findings.");
      if (!findings.length) { context.finish("completed", "Both code and intent reviews passed with no findings."); return; }
    }
    context.finish("limited", `Review iteration limit reached. Unresolved findings:\n\n${findings.join("\n\n")}`);
  }
}
