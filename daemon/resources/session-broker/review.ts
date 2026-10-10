import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { writeSessionFile } from "./session-file.ts";
import type { SessionAgentState, SubagentProfileRequest } from "../../../extensions/piop-define-agents/contracts.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { currentHost } from "./client.ts";
import { locateConversation } from "./conversation-location.ts";
import { acknowledge, pendingReviews, release, type SessionPublication } from "./session-publication.cjs";
import { read as readAppSettings } from "./app-settings.cjs";

const reviewSchema = Schema.Object({ sessionId: Schema.String(), sessionPath: Schema.String(), cwd: Schema.String(), parentSessionId: Schema.String(), hostId: Schema.Optional(Schema.String()), publicationId: Schema.Optional(Schema.String()) });

const settingsSchema = Schema.Object({ reviewAgent: Schema.Optional(Schema.String()), reviewPrompt: Schema.Optional(Schema.String()) });

const fileErrorSchema = Schema.Object({ code: Schema.String() });

const reviewRequestSchema = Schema.Object({ command: Schema.Optional(Schema.Union([Schema.Literal("review"), Schema.Literal("rs")])), args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

const sessionHeaderSchema = Schema.Object({ type: Schema.Literal("session"), id: Schema.String() });

type ReviewRecord = Static<typeof reviewSchema>;

const feedbackSchema = Schema.Object({ sessionId: Schema.String(), message: Schema.String({ minLength: 1 }) });

const feedbackDetailsSchema = Schema.Object({ toolCallId: Schema.String() });

async function requireSavedReviewParent(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();
  const message = "Send a message in the main conversation before starting a review";

  if (!path) throw new Error(message);
  let file;

  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (Check(fileErrorSchema, error) && error.code === "ENOENT") throw new Error(message); throw error; }

  try {
    if (!(await file.stat()).isFile()) throw new Error("The main conversation transcript must be a regular file");
    const content = await file.readFile("utf8");
    const end = content.indexOf("\n");

    if (end < 0) throw new Error(message);
    const header = JSON.parse(content.slice(0, end));

    if (!Check(sessionHeaderSchema, header) || header.id !== ctx.sessionManager.getSessionId()) throw new Error("The saved main conversation does not match this session");
  } finally { await file.close(); }
}

async function createReview(ctx: ExtensionContext, agentState: SessionAgentState, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const header = ctx.sessionManager.getHeader();

  const parentSessionPath = ctx.sessionManager.getSessionFile();

  if (!header || !parentSessionPath) throw new Error("Save the main conversation before starting a review");
  await requireSavedReviewParent(ctx);
  signal?.throwIfAborted();
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const record = { sessionId, sessionPath: join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(), publicationId: randomUUID() };
  const metadataId = randomUUID().slice(0, 8);

  const publication = await writeSessionFile(record.sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "custom", id: metadataId, parentId: null, timestamp, customType: "piop-review-parent", data: { parentSessionId: record.parentSessionId, sessionId, hostId: record.hostId, parentHostId: record.hostId, publicationId: record.publicationId } },
    { type: "custom", id: `${metadataId}-agent`, parentId: metadataId, timestamp, customType: "pi-define-agents-state", data: agentState },
    { type: "session_info", id: randomUUID().slice(0, 8), parentId: `${metadataId}-agent`, timestamp, name: "Code review" },
  ], { review: { record, parentSessionPath }, beforeWrite: () => signal?.throwIfAborted() });

  return { record, publication };
}

function matchesPublication(value: ReviewRecord, record: ReviewRecord) {
  return value.sessionId === record.sessionId && value.parentSessionId === record.parentSessionId && value.publicationId === record.publicationId && value.hostId === record.hostId;
}

async function publishReview(pi: ExtensionAPI, ctx: ExtensionContext, record: ReviewRecord, publication: SessionPublication) {
  try {
    if (ctx.sessionManager.getSessionId() !== record.parentSessionId) throw new Error("Review publication requires its actual original parent");
    const saved = ctx.sessionManager.getEntries();

    if (!saved.some(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && matchesPublication(entry.data, record))) pi.appendEntry("piop-review", record);

    if (!saved.some(entry => entry.type === "custom_message" && entry.customType === "piop-review-link" && Check(reviewSchema, entry.details) && matchesPublication(entry.details, record))) pi.sendMessage({ customType: "piop-review-link", content: "Code review", display: true, details: record }, { triggerTurn: false });

    if (!await acknowledge(publication)) ctx.ui.notify(`Review parent publication is pending; the transcript is retained at ${record.sessionPath}`, "warning");
  } finally { release(publication); }
}

async function reconcileReviews(pi: ExtensionAPI, ctx: ExtensionContext) {
  const parent = ctx.sessionManager.getSessionFile();
  const parentId = ctx.sessionManager.getSessionId();

  if (!parent) return;
  const current = () => ctx.sessionManager.getSessionFile() === parent && ctx.sessionManager.getSessionId() === parentId;

  try {
    const pending = await pendingReviews(parent, parentId);

    try {
      for (const item of pending) {
        if (!current()) return;
        await publishReview(pi, ctx, item.record, item.publication);
      }
    }
    finally { for (const item of pending) release(item.publication); }
  } catch (error) { if (current()) ctx.ui.notify(`Review publication recovery is pending: ${String(error)}`, "warning"); }
}

async function openReview(ctx: ExtensionContext, record: ReviewRecord, task?: string, inherited = false, images?: Static<typeof reviewRequestSchema>["images"]) {
  const hostId = record.hostId ?? currentHost();
  const location = await locateConversation(record.sessionId, hostId);
  ctx.ui.setStatus("review", "Opening code review…");
  const readOnly = inherited || location.archived;
  const payload: ReviewRecord & { task?: string; images?: Static<typeof reviewRequestSchema>["images"]; readOnly: boolean; archived: boolean; inherited: boolean } = { ...record, ...location, hostId, readOnly, inherited };

  if (task && !readOnly) { payload.task = task; payload.images = images; }

  void ctx.ui.input("__pi_desktop_review__", JSON.stringify(payload)).catch(error => {
    ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }).finally(() => ctx.ui.setStatus("review", undefined));
}

async function reviewSettings() {
  const settings = Parse(settingsSchema, readAppSettings(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop")) ?? {});

  const agent = settings.reviewAgent?.trim() || "general";
  const prompt = settings.reviewPrompt ?? await readFile(new URL("./review-prompt.txt", import.meta.url), "utf8");

  if (!prompt.trim()) throw new Error("Set a review prompt in Settings → Review");

  return { agent, prompt };
}

function reviewSubagentCount(args: string, command: string, ctx: ExtensionContext) {
  if (command === "review") return 0;

  if (!args.trim()) return null;
  const count = Number(args.trim());

  if (/^[1-9]\d*$/.test(args.trim()) && Number.isSafeInteger(count)) return count;
  ctx.ui.notify("Usage: /rs [n] — omit n for proportionate delegation, or supply a positive integer", "warning");
}

function subagentReviewTask(state: SessionAgentState, count: number | null, prompt: string) {
  if (count === 0) return prompt;

  if (!state.snapshot) throw new Error("Reviewer profile is unavailable for subagent review");
  const limit = state.snapshot.definition.max_subagents ?? 8;

  if (!limit) throw new Error("The review agent's max_subagents must be greater than zero to use /rs");
  const tools = state.snapshot.definition.tools;

  if (!tools.includes("subagent")) tools.push("subagent");
  state.locked = true;

  const delegation = count === null
    ? "First assess the scope, complexity, and risk of the requested review, then choose a proportionate number of review subagents. Use only as many subagents as the task warrants, avoiding redundant work."
    : `You must spawn exactly ${count} review subagents.`;

  return `${prompt}\n\nFor this review: ${delegation} Spawn them using spawn_agent with unique task names. Omit agent to inherit your reviewer profile. Divide the review into complementary scopes and give each child the review instructions above, including the files and behavior to inspect. Children must not delegate further, modify files, or run tests. Launch children concurrently, with at most ${limit} active at once; for larger counts, launch the remaining children as slots become available. Collect every subagent's results before giving your final review. Verify and deduplicate their findings, then report one consolidated review.`;
}

async function reviewProfile(pi: ExtensionAPI, agent: string) {
  const profile: SubagentProfileRequest = { agent };
  pi.events.emit("piop:agents:subagent", profile);
  await profile.ready;

  if (!profile.state || profile.error) throw new Error(profile.error || `Review agent unavailable: ${agent}`);

  return profile.state;
}

export function registerReview(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => reconcileReviews(pi, ctx));
  pi.on("agent_settled", (_event, ctx) => reconcileReviews(pi, ctx));
  pi.events.on("piop:rpc", request => {
    if (request.command !== "review_feedback") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const feedback = Parse(feedbackSchema, request.payload);
      const review = ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && entry.data.sessionId === feedback.sessionId && entry.data.parentSessionId === ctx.sessionManager.getSessionId());

      if (!review || !feedback.message.trim()) throw new Error("Feedback requires a review belonging to this conversation");
      pi.sendMessage({ customType: "piop-review-feedback", content: feedback.message, display: true, details: { sessionId: feedback.sessionId, toolCallId: randomUUID() } }, { triggerTurn: true, deliverAs: "followUp" });
    })();
  });
  pi.on("context", event => ({ messages: event.messages.flatMap((message): typeof event.messages => {
    if (message.role !== "custom" || message.customType !== "piop-review-feedback" || !Check(feedbackDetailsSchema, message.details)) return [message];
    const toolCallId = message.details.toolCallId;

    return [
      { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "review_feedback", arguments: {} }], api: "openai-responses", provider: "piop", model: "review", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: message.timestamp },
      { role: "toolResult", toolCallId, toolName: "review_feedback", content: [{ type: "text", text: Parse(Schema.String(), message.content) }], isError: false, timestamp: message.timestamp },
    ];
  }) }));

  const startReview = async (args: string, ctx: ExtensionContext, images?: Static<typeof reviewRequestSchema>["images"], command = "review") => {
    const signal = ctx.signal;
    signal?.throwIfAborted();
    const count = reviewSubagentCount(args, command, ctx);

    if (count === undefined) return;

    signal?.throwIfAborted();
    const settings = await reviewSettings();
    signal?.throwIfAborted();
    const profile = await reviewProfile(pi, settings.agent);
    signal?.throwIfAborted();

    const prompt = command === "review" && args.trim() ? `${settings.prompt}

Review scope supplied by the user:
${args.trim()}` : settings.prompt;

    const task = subagentReviewTask(profile, count, prompt);
    const { record, publication } = await createReview(ctx, profile, signal);
    await publishReview(pi, ctx, record, publication);
    signal?.throwIfAborted();
    await openReview(ctx, record, task, false, images);
  };

  pi.registerCommand("review", {
    description: "Review files in the current directory in a side pane",
    handler: (args, ctx) => startReview(args, ctx),
  });
  pi.registerCommand("rs", {
    description: "Review with proportionate delegation, or an explicit subagent count: /rs [n]",
    handler: (args, ctx) => startReview(args, ctx, undefined, "rs"),
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "start_review") return;
    request.ready = (async () => {
      const payload = Parse(reviewRequestSchema, request.payload);
      await startReview(payload.args, request.ctx, payload.images, payload.command);
    })();
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "open_review") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const { reviewId } = Parse(Schema.Object({ reviewId: Schema.String() }), request.payload);
      const entry = ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && entry.data.sessionId === reviewId);

      if (!entry || entry.type !== "custom") throw new Error("Review not found in this conversation");
      const record = Parse(reviewSchema, entry.data);

      await openReview(ctx, record, undefined, record.parentSessionId !== ctx.sessionManager.getSessionId());
    })();
  });
}
