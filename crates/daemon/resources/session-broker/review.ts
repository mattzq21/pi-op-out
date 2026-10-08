import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeSessionFile } from "./session-file.ts";
import type { SessionAgentState, SubagentProfileRequest } from "../../../../extensions/piop-define-agents/contracts.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { currentHost } from "./client.ts";
import { locateConversation } from "./conversation-location.ts";
import { acknowledge, pendingReviews, release, type SessionPublication } from "./session-publication.cjs";

const reviewSchema = Schema.Object({ sessionId: Schema.String(), sessionPath: Schema.String(), cwd: Schema.String(), parentSessionId: Schema.String(), hostId: Schema.Optional(Schema.String()), publicationId: Schema.Optional(Schema.String()) });

const settingsSchema = Schema.Object({ reviewAgent: Schema.Optional(Schema.String()), reviewPrompt: Schema.Optional(Schema.String()) });

const fileErrorSchema = Schema.Object({ code: Schema.String() });

const sessionHeaderSchema = Schema.Object({ type: Schema.Literal("session"), id: Schema.String() });

type ReviewRecord = Static<typeof reviewSchema>;

const feedbackSchema = Schema.Object({ sessionId: Schema.String(), message: Schema.String({ minLength: 1 }) });

const feedbackDetailsSchema = Schema.Object({ toolCallId: Schema.String() });

const runFile = promisify(execFile);

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

async function requireReviewRepository(cwd: string) {
  try {
    const { stdout } = await runFile("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeout: 5000 });

    if (stdout.trim() === "true") return;
  } catch { }

  throw new Error("/review is only available in Git repository projects");
}

async function createReview(ctx: ExtensionContext, agentState: SessionAgentState) {
  const header = ctx.sessionManager.getHeader();

  const parentSessionPath = ctx.sessionManager.getSessionFile();

  if (!header || !parentSessionPath) throw new Error("Save the main conversation before starting a review");
  await requireSavedReviewParent(ctx);
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const record = { sessionId, sessionPath: join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(), publicationId: randomUUID() };
  const metadataId = randomUUID().slice(0, 8);

  const publication = await writeSessionFile(record.sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "custom", id: metadataId, parentId: null, timestamp, customType: "piop-review-parent", data: { parentSessionId: record.parentSessionId, sessionId, hostId: record.hostId, parentHostId: record.hostId, publicationId: record.publicationId } },
    { type: "custom", id: `${metadataId}-agent`, parentId: metadataId, timestamp, customType: "pi-define-agents-state", data: agentState },
    { type: "session_info", id: randomUUID().slice(0, 8), parentId: `${metadataId}-agent`, timestamp, name: "Code review" },
  ], { review: { record, parentSessionPath } });

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

    if (!acknowledge(publication)) ctx.ui.notify(`Review parent publication is pending; the transcript is retained at ${record.sessionPath}`, "warning");
  } finally { release(publication); }
}

async function reconcileReviews(pi: ExtensionAPI, ctx: ExtensionContext) {
  const parent = ctx.sessionManager.getSessionFile();

  if (!parent) return;

  try {
    const pending = pendingReviews(parent, ctx.sessionManager.getSessionId());

    try { for (const item of pending) await publishReview(pi, ctx, item.record, item.publication); }
    finally { for (const item of pending) release(item.publication); }
  } catch (error) { ctx.ui.notify(`Review publication recovery is pending: ${String(error)}`, "warning"); }
}

async function openReview(ctx: ExtensionContext, record: ReviewRecord, task?: string, inherited = false) {
  const hostId = record.hostId ?? currentHost();
  const location = await locateConversation(record.sessionId, hostId);
  ctx.ui.setStatus("review", "Opening code review…");
  const readOnly = inherited || location.archived;
  const payload: ReviewRecord & { task?: string; readOnly: boolean; archived: boolean; inherited: boolean } = { ...record, ...location, hostId, readOnly, inherited };

  if (task && !readOnly) payload.task = task;

  void ctx.ui.input("__pi_desktop_review__", JSON.stringify(payload)).catch(error => {
    ctx.ui.notify(`/review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }).finally(() => ctx.ui.setStatus("review", undefined));
}

async function reviewSettings() {
  let settings: Static<typeof settingsSchema> = {};

  try { settings = Parse(settingsSchema, JSON.parse(await readFile(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "settings.json"), "utf8"))); }
  catch (error) { if (!Check(fileErrorSchema, error) || error.code !== "ENOENT") throw error; }

  const agent = settings.reviewAgent?.trim() || "general";
  const prompt = settings.reviewPrompt ?? await readFile(new URL("./review-prompt.txt", import.meta.url), "utf8");

  if (!prompt.trim()) throw new Error("Set a review prompt in Settings → Review");

  return { agent, prompt };
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
  pi.registerCommand("review", {
    description: "Review this branch against its base in a side pane",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /review — reviews the current branch", "warning");

      return; }

      await requireReviewRepository(ctx.cwd);
      const settings = await reviewSettings();
      const profile: SubagentProfileRequest = { agent: settings.agent };
      pi.events.emit("piop:agents:subagent", profile);
      await profile.ready;

      if (!profile.state || profile.error) throw new Error(profile.error || `Review agent unavailable: ${settings.agent}`);
      const { record, publication } = await createReview(ctx, profile.state);
      await publishReview(pi, ctx, record, publication);
      await openReview(ctx, record, settings.prompt);
    },
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
