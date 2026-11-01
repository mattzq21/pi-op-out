// Background compaction ported from OpenCode (packages/core/src/session/compaction.ts).
// OpenCode: MIT License, Copyright (c) 2025 opencode.
import { buildSessionProjection, convertToLlm, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

type AgentMessage = TurnEndEvent["message"];

/** Share of the compaction threshold at which a background summary starts. */
const START_RATIO = 0.85;
/** Prompt tokens of the latest response below which a background summary is not worth its cost. */
const MIN_PROMPT_TOKENS = 64_000;
/** The most text a swapped-in summary keeps verbatim: twice `keepRecentTokens`, at least 30k, at most a quarter of the threshold. */
const TAIL_MIN = 30_000;
const TAIL_SHARE = 0.25;
/** Failed background summaries after which no new one starts while the held one is still valid. */
const MAX_FAILURES = 2;
const SOURCE = "piop-background-compaction";

const TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`;

const RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`;

const NUDGE = "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.";

const HEADINGS = TEMPLATE.split("\n").filter(line => line.startsWith("##"));

function buildPrompt(update: boolean): string {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    TEMPLATE,
    RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ];

  if (!update) return ["You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.", ...shared].join("\n\n");

  return [
    "Update the existing summary in the conversation above into one consolidated summary.",
    "Newer history always takes precedence over the existing summary. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<summary>` wrapper tags from the previous summary.",
    ...shared,
  ].join("\n\n");
}

/** A summary of everything before `keepId`, written while the session goes on, held until compaction is due. */
type Held = {
  readonly keepId: string;
  readonly compactionId: string | null;
  readonly edits: ReadonlySet<string>;
  readonly model: { readonly provider: string; readonly id: string };
  /** Failed background summaries since the last compaction, this one included once it has failed. */
  failures: number;
  failed: boolean;
  readonly abort: AbortController;
  readonly summary: Promise<string | undefined>;
};

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

const replyText = (reply: AssistantMessage) => reply.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();

const filled = (text: string) => text.split("\n").some(line => HEADINGS.includes(line.trim()));

function latestCompactionId(branch: SessionEntry[]): string | null {
  return branch.findLast(entry => entry.type === "compaction")?.id ?? null;
}

function editIds(branch: SessionEntry[]): Set<string> {
  return new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.id] : []));
}

/** Estimated tokens kept verbatim beside the summary: every message from `keepId` on. */
function tailTokens(branch: SessionEntry[], keepId: string): number {
  const entries = buildSessionProjection(branch).entries;
  const index = entries.findIndex(entry => entry.sourceEntry.id === keepId);

  if (index < 0) return Number.POSITIVE_INFINITY;

  return entries.slice(index).flatMap(entry => entry.messages).reduce((sum, message) => message.role === "system" ? sum : sum + estimateTokens(message), 0);
}

const tailLimit = (keep: number, threshold: number) => Math.min(Math.max(keep * 2, TAIL_MIN), Math.floor(threshold * TAIL_SHARE));

/** Whether `held` still describes this branch: the same latest compaction and model, its kept entry present, and no summarized entry edited. */
function describes(held: Held, branch: SessionEntry[], ctx: ExtensionContext): boolean {
  if (latestCompactionId(branch) !== held.compactionId) return false;
  if (ctx.model?.provider !== held.model.provider || ctx.model.id !== held.model.id) return false;
  const keep = branch.findIndex(entry => entry.id === held.keepId);

  if (keep < 0) return false;
  const summarized = new Set(branch.slice(0, keep).map(entry => entry.id));

  return !branch.some(entry => entry.type === "context_edit" && !held.edits.has(entry.id) && summarized.has(entry.targetId));
}

function addUsage(total: Usage | undefined, usage: Usage): Usage {
  if (!total) return structuredClone(usage);

  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    ...(total.reasoning !== undefined || usage.reasoning !== undefined ? { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) } : {}),
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

export default function backgroundCompaction(pi: ExtensionAPI) {
  let held: Held | undefined;
  let request: AgentMessage[] | undefined;
  /** Spend of every background summary not yet recorded on a compaction this plugin supplied. */
  let spent: Usage | undefined;

  const compactionSettings = (model: NonNullable<ExtensionContext["model"]>) => SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(model);

  /**
   * Summarizes `messages`, the request that produced the latest response, plus the summary prompt. The request is the
   * prefix the provider just processed, so the summary reads it from the prompt cache. A reply that ignores the
   * template gets one reminder before it counts as a failure.
   */
  const summarize = async (ctx: ExtensionContext, messages: AgentMessage[], maxTokens: number, signal: AbortSignal): Promise<string> => {
    const model = ctx.model!;
    const thinking = ctx.thinkingLevel;
    const options = { signal, maxTokens, sessionId: ctx.sessionManager.getSessionId(), ...(model.reasoning && thinking && thinking !== "off" ? { reasoning: thinking } : {}) };
    const prompted = [...convertToLlm(messages), userMessage(buildPrompt(messages.some(message => message.role === "compactionSummary")))];
    const send = async (context: Message[]) => {
      const reply = await ctx.modelRegistry.streamSimple(model, { messages: context }, options).result();
      spent = addUsage(spent, reply.usage);

      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || `the summary request was ${reply.stopReason === "error" ? "rejected" : "aborted"}`);

      if (reply.stopReason === "length") throw new Error("the summary hit the output token limit");

      return replyText(reply);
    };
    const first = await send(prompted);

    if (filled(first)) return first;
    const retry = await send([...prompted, userMessage(NUDGE)]);

    if (filled(retry)) return retry;
    throw new Error(retry ? "the summary did not match the required template" : "the summary was empty");
  };

  /**
   * Once the context passes `START_RATIO` of the threshold, summarizes everything before the latest response in the
   * background. The summary is held, not applied: swapping it in now would rewrite the prefix and throw away the cache
   * for every step until compaction is due. One summary is held until compaction takes it, or until it fails or falls
   * too far behind, when a newer response replaces it.
   */
  const precompute = (event: TurnEndEvent, sent: AgentMessage[] | undefined, ctx: ExtensionContext) => {
    const message = event.message;
    const model = ctx.model;

    if (!sent || message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || !model) return;
    // After a model switch nothing is cached for the new model yet; wait until its first response has written it.
    if (message.provider !== model.provider || message.model !== model.id) return;
    const settings = compactionSettings(model);
    const usage = ctx.getContextUsage();

    if (!settings.enabled || !usage || usage.tokens === null) return;
    const threshold = usage.contextWindow - settings.reserveTokens;

    if (threshold <= 0 || usage.tokens > threshold || usage.tokens < threshold * START_RATIO) return;

    if (message.usage.input + message.usage.cacheRead + message.usage.cacheWrite < MIN_PROMPT_TOKENS) return;
    const branch = ctx.sessionManager.getBranch();
    const existing = held;
    const failures = (existing?.failures ?? 0) + (existing?.failed ? 1 : 0);

    if (existing) {
      const valid = describes(existing, branch, ctx);

      if (valid && !existing.failed && tailTokens(branch, existing.keepId) <= tailLimit(settings.keepRecentTokens, threshold)) return;
      // Summarizing up to the same response again would repeat the same request.
      if (valid && (existing.keepId === event.messageEntryId || failures >= MAX_FAILURES)) return;
      existing.abort.abort();
      held = undefined;
    }

    const maxTokens = Math.min(model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY, model.contextWindow - usage.tokens);

    if (maxTokens < 1024) return;
    const abort = new AbortController();
    const next: Held = {
      keepId: event.messageEntryId,
      compactionId: latestCompactionId(branch),
      edits: editIds(branch),
      model: { provider: model.provider, id: model.id },
      failures,
      failed: false,
      abort,
      summary: summarize(ctx, sent, maxTokens, abort.signal).catch((error: unknown) => {
        next.failed = true;

        if (!abort.signal.aborted) ctx.ui.notify(`Background compaction failed: ${error instanceof Error ? error.message : String(error)}. Pi will write the summary when compaction is due.`, "warning");

        return undefined;
      }),
    };
    held = next;
  };

  pi.on("context_with_system", event => {
    request = event.messages;
  });

  pi.on("turn_end", (event, ctx) => {
    const sent = request;
    request = undefined;
    precompute(event, sent, ctx);
  });

  /**
   * The held summary plus everything since it, kept verbatim, when it still describes this branch and that tail is
   * short. Waits for a summary still being written. Otherwise Pi writes the summary.
   */
  pi.on("session_before_compact", async (event, ctx) => {
    const current = held;
    held = undefined;

    if (!current) return;
    const usage = ctx.getContextUsage();
    const settings = event.preparation.settings;
    const usable = event.reason !== "overflow" && !event.customInstructions && usage !== undefined
      && describes(current, event.branchEntries, ctx)
      && tailTokens(event.branchEntries, current.keepId) <= tailLimit(settings.keepRecentTokens, usage.contextWindow - settings.reserveTokens);

    if (!usable) {
      current.abort.abort();

      return;
    }

    const stop = () => current.abort.abort();
    event.signal.addEventListener("abort", stop, { once: true });
    let summary: string | undefined;

    try {
      summary = await current.summary;
    } finally {
      event.signal.removeEventListener("abort", stop);
    }

    if (summary === undefined || event.signal.aborted) return;
    const compaction: CompactionResult = { summary, firstKeptEntryId: current.keepId, tokensBefore: event.preparation.tokensBefore, details: { source: SOURCE }, ...(spent ? { usage: spent } : {}) };

    return { compaction };
  });

  pi.on("session_compact", event => {
    if (event.fromExtension && (event.compactionEntry.details as { source?: unknown } | undefined)?.source === SOURCE) spent = undefined;
  });

  pi.on("session_shutdown", () => {
    held?.abort.abort();
    held = undefined;
    request = undefined;
  });
}
