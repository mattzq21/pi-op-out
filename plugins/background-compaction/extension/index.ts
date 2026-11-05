// Background compaction ported from OpenCode (packages/core/src/session/compaction.ts), with Pi's summary format.
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

const SUMMARIZER = `You are now a context summarization assistant. Read the conversation above between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. Do NOT call tools. ONLY output the structured summary.`;

const FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_FORMAT = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const NUDGE = "The previous response did not use the required summary format. Do not call tools. Return the summary as text using the exact section headings from the format.";

const HEADINGS = FORMAT.split("\n").filter(line => line.startsWith("##"));

/** Pi's summary prompts, worded for a request that holds the conversation itself rather than a text copy of it. */
function buildPrompt(update: boolean): string {
  if (!update) return `${SUMMARIZER}\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\n${FORMAT}`;

  return `${SUMMARIZER}\n\nThe messages above are a conversation to summarize. It starts with an existing summary in <summary> tags; incorporate the newer messages into it. Do not reproduce the <summary> tags.\n\n${UPDATE_FORMAT}`;
}

type FileLists = { readFiles: string[]; modifiedFiles: string[] };

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Pi's file lists: the latest compaction's lists plus the files that `messages` read, wrote, or edited. */
function fileLists(messages: AgentMessage[], branch: SessionEntry[]): FileLists {
  const details = branch.findLast(entry => entry.type === "compaction")?.details as Partial<Record<keyof FileLists, unknown>> | undefined;
  const read = new Set(strings(details?.readFiles));
  const modified = new Set(strings(details?.modifiedFiles));
  const add = (name: string, args: unknown) => {
    const path = (args as { path?: unknown } | undefined)?.path;

    if (typeof path !== "string" || !path) return;

    if (name === "read") read.add(path);
    else if (name === "write" || name === "edit") modified.add(path);
  };

  for (const message of messages) {
    if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
    if (message.role === "toolResult") for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
  }

  return { readFiles: [...read].filter(path => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}

function formatFiles({ readFiles, modifiedFiles }: FileLists): string {
  const sections = [
    ...(readFiles.length ? [`<read-files>\n${readFiles.join("\n")}\n</read-files>`] : []),
    ...(modifiedFiles.length ? [`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`] : []),
  ];

  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

/** A summary of everything before `keepId`, written while the session goes on, held until compaction is due. */
type Held = {
  readonly keepId: string;
  readonly compactionId: string | null;
  readonly edits: ReadonlySet<string>;
  readonly model: { readonly provider: string; readonly id: string };
  readonly files: FileLists;
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
      files: fileLists(sent, branch),
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
    const compaction: CompactionResult = { summary: summary + formatFiles(current.files), firstKeptEntryId: current.keepId, tokensBefore: event.preparation.tokensBefore, details: { ...current.files, source: SOURCE }, ...(spent ? { usage: spent } : {}) };

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
