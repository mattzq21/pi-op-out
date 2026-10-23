import { sessionStorage } from "../../resources/piop-storage/interface.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { reserveSessionId, writeSessionFile } from "../../resources/piop-storage/session-file.ts";
import type { SessionAgentState, SubagentProfileRequest } from "../../../extensions/piop-define-agents/contracts.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { currentHost } from "../../resources/session-broker/client.ts";
import { childFastModeEntry } from "../../resources/session-broker/fast-mode.ts";
import { locateConversation } from "../../resources/session-broker/conversation-location.ts";
import { acknowledge, pendingReviews, release, type SessionPublication } from "../../resources/piop-storage/session-publication.cjs";
import { read as readAppSettings } from "../../resources/session-broker/app-settings.cjs";
import type { ReviewDelegation, ReviewImage, ReviewSession } from "./interface.ts";

const reviewSchema = Schema.Object({ sessionId: Schema.String(), sessionPath: Schema.String(), cwd: Schema.String(), parentSessionId: Schema.String(), hostId: Schema.Optional(Schema.String()), publicationId: Schema.Optional(Schema.String()) });

const settingsSchema = Schema.Object({ reviewAgent: Schema.Optional(Schema.String()) });

const fileErrorSchema = Schema.Object({ code: Schema.String() });

const sessionHeaderSchema = Schema.Object({ type: Schema.Literal("session"), id: Schema.String() });

type ReviewRecord = Static<typeof reviewSchema>;

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

async function createReview(pi: ExtensionAPI, ctx: ExtensionContext, agentState: SessionAgentState, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const header = ctx.sessionManager.getHeader();

  const parentSessionPath = ctx.sessionManager.getSessionFile();

  if (!header || !parentSessionPath) throw new Error("Save the main conversation before starting a review");
  await requireSavedReviewParent(ctx);
  signal?.throwIfAborted();
  const fastMode = await childFastModeEntry(pi, agentState, true);
  signal?.throwIfAborted();
  const timestamp = new Date().toISOString();
  const sessionId = await reserveSessionId();
  const record = { sessionId, sessionPath: join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(), publicationId: randomUUID() };
  const metadataId = randomUUID();

  const publication = await writeSessionFile(record.sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "custom", id: metadataId, parentId: null, timestamp, customType: "piop-review-parent", data: { parentSessionId: record.parentSessionId, sessionId, hostId: record.hostId, parentHostId: record.hostId, publicationId: record.publicationId } },
    { type: "custom", id: `${metadataId}-agent`, parentId: metadataId, timestamp, customType: "pi-define-agents-state", data: agentState },
    ...fastMode ? [{ ...fastMode, id: `${metadataId}-fast-mode`, parentId: `${metadataId}-agent`, timestamp }] : [],
    { type: "session_info", id: randomUUID(), parentId: fastMode ? `${metadataId}-fast-mode` : `${metadataId}-agent`, timestamp, name: "Code review" },
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

    if (!saved.some(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && matchesPublication(entry.data, record))) sessionStorage(pi).append("piop-review", record);

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
  } catch (error) { if (current()) ctx.ui.notify(`Review publication recovery is pending: ${(error instanceof Error ? error.message : String(error))}`, "warning"); }
}

async function openReview(ctx: ExtensionContext, record: ReviewRecord, task?: string, inherited = false, images?: ReviewImage[]) {
  const hostId = record.hostId ?? currentHost();
  const location = await locateConversation(record.sessionId, hostId);
  ctx.ui.setStatus("review", "Opening code review…");
  const readOnly = inherited || location.archived;
  const payload: ReviewRecord & { task?: string; images?: ReviewImage[]; readOnly: boolean; archived: boolean; inherited: boolean } = { ...record, ...location, hostId, readOnly, inherited };

  if (task && !readOnly) { payload.task = task; payload.images = images; }

  void ctx.ui.input("__pi_desktop_review__", JSON.stringify(payload)).catch(error => {
    ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }).finally(() => ctx.ui.setStatus("review", undefined));
}

async function reviewSettings() {
  const settings = Parse(settingsSchema, readAppSettings(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop")) ?? {});

  const agent = settings.reviewAgent?.trim() || "general";
  const prompt = await readFile(new URL("./review-prompt.txt", import.meta.url), "utf8");

  return { agent, prompt };
}

function subagentReviewTask(state: SessionAgentState, delegation: ReviewDelegation, prompt: string) {
  if (delegation === "none") return prompt;

  if (typeof delegation === "number" && (!Number.isSafeInteger(delegation) || delegation < 1)) throw new Error("The review subagent count must be a positive integer");

  if (!state.snapshot) throw new Error("Reviewer profile is unavailable for subagent review");
  const limit = state.snapshot.definition.max_subagents ?? 8;

  if (!limit) throw new Error("The review agent's max_subagents must be greater than zero to use /rs");
  const tools = state.snapshot.definition.tools;

  if (!tools.includes("spawn_subagents")) tools.push("spawn_subagents");
  state.locked = true;

  const count = delegation === "auto" ? "a proportionate number of" : String(delegation);

  return `${prompt}\n\nSpawn ${count} review subagents. Split the scope between them, and report one consolidated review.`;
}

async function reviewProfile(pi: ExtensionAPI, agent: string) {
  const profile: SubagentProfileRequest = { agent };
  pi.events.emit("piop:agents:subagent", profile);
  await profile.ready;

  if (!profile.state || profile.error) throw new Error(profile.error || `Review agent unavailable: ${agent}`);

  return profile.state;
}

/** Registers review publication recovery and review feedback context, and returns the review feature. */
export function registerReviews(pi: ExtensionAPI): ReviewSession {
  pi.on("session_start", (_event, ctx) => reconcileReviews(pi, ctx));
  pi.on("agent_settled", (_event, ctx) => reconcileReviews(pi, ctx));
  pi.on("context", event => ({ messages: event.messages.flatMap((message): typeof event.messages => {
    if (message.role !== "custom" || message.customType !== "piop-review-feedback" || !Check(feedbackDetailsSchema, message.details)) return [message];
    const toolCallId = message.details.toolCallId;

    return [
      { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "review_feedback", arguments: {} }], api: "openai-responses", provider: "piop", model: "review", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: message.timestamp },
      { role: "toolResult", toolCallId, toolName: "review_feedback", content: [{ type: "text", text: Parse(Schema.String(), message.content) }], isError: false, timestamp: message.timestamp },
    ];
  }) }));

  const linkedReview = (ctx: ExtensionContext, reviewId: string) => ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && entry.data.sessionId === reviewId);

  return {
    async start(ctx, request) {
      const signal = ctx.signal;
      signal?.throwIfAborted();
      const settings = await reviewSettings();
      signal?.throwIfAborted();
      const profile = await reviewProfile(pi, settings.agent);
      signal?.throwIfAborted();

      // The user scope, or else the changes since the branch point, follows the prompt as its last paragraph.
      const prompt = `${settings.prompt.trimEnd()}\n\n${request.scope?.trim() ? `Review ${request.scope.trim()}` : "Review the scope affected since last branch off."}`;

      const task = subagentReviewTask(profile, request.delegation, prompt);
      const { record, publication } = await createReview(pi, ctx, profile, signal);
      await publishReview(pi, ctx, record, publication);
      signal?.throwIfAborted();
      await openReview(ctx, record, task, false, request.images);
    },
    async open(ctx, reviewId) {
      const entry = linkedReview(ctx, reviewId);

      if (!entry || entry.type !== "custom") throw new Error("Review not found in this conversation");
      const record = Parse(reviewSchema, entry.data);

      await openReview(ctx, record, undefined, record.parentSessionId !== ctx.sessionManager.getSessionId());
    },
    async sendFeedback(ctx, reviewId, message) {
      const parentId = ctx.sessionManager.getSessionId();
      const review = ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "piop-review" && Check(reviewSchema, entry.data) && entry.data.sessionId === reviewId && entry.data.parentSessionId === parentId);

      if (!review || !message.trim()) throw new Error("Feedback requires a review belonging to this conversation");
      pi.sendMessage({ customType: "piop-review-feedback", content: message, display: true, details: { sessionId: reviewId, toolCallId: randomUUID() } }, { triggerTurn: true, deliverAs: "followUp" });
    },
  };
}
