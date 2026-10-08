import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeSessionFile } from "./session-file.ts";
import type { SessionAgentState, SubagentProfileRequest } from "../../../extensions/piop-define-agents/contracts.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

const reviewSchema = Schema.Object({ sessionId: Schema.String(), sessionPath: Schema.String(), cwd: Schema.String(), parentSessionId: Schema.String() });

const settingsSchema = Schema.Object({ reviewAgent: Schema.Optional(Schema.String()), reviewPrompt: Schema.Optional(Schema.String()) });

const fileErrorSchema = Schema.Object({ code: Schema.String() });

const reviewRequestSchema = Schema.Object({ args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

type ReviewRecord = Static<typeof reviewSchema>;

const feedbackSchema = Schema.Object({ sessionId: Schema.String(), message: Schema.String({ minLength: 1 }) });

const feedbackDetailsSchema = Schema.Object({ toolCallId: Schema.String() });

const runFile = promisify(execFile);

async function requireReviewRepository(cwd: string) {
  try {
    const { stdout } = await runFile("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeout: 5000 });

    if (stdout.trim() === "true") return;
  } catch { }

  throw new Error("/review is only available in Git repository projects");
}

async function createReview(ctx: ExtensionContext, agentState: SessionAgentState): Promise<ReviewRecord> {
  const header = ctx.sessionManager.getHeader();

  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save the main conversation before starting a review");
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const record = { sessionId, sessionPath: join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId() };
  const metadataId = randomUUID().slice(0, 8);
  await writeSessionFile(record.sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "custom", id: metadataId, parentId: null, timestamp, customType: "piop-review-parent", data: { parentSessionId: record.parentSessionId } },
    { type: "custom", id: `${metadataId}-agent`, parentId: metadataId, timestamp, customType: "pi-define-agents-state", data: agentState },
    { type: "session_info", id: randomUUID().slice(0, 8), parentId: `${metadataId}-agent`, timestamp, name: "Code review" },
  ]);

  return record;
}

function openReview(ctx: ExtensionContext, record: ReviewRecord, task?: string, images?: Static<typeof reviewRequestSchema>["images"]) {
  ctx.ui.setStatus("review", "Opening code review…");
  void ctx.ui.input("__pi_desktop_review__", JSON.stringify(task ? { ...record, task, images } : record)).catch(error => {
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
  const startReview = async (args: string, ctx: ExtensionContext, images?: Static<typeof reviewRequestSchema>["images"]) => {
    if (args.trim()) { ctx.ui.notify("Usage: /review — reviews the current branch", "warning");

    return; }

    await requireReviewRepository(ctx.cwd);
    const settings = await reviewSettings();
    const profile: SubagentProfileRequest = { agent: settings.agent };
    pi.events.emit("piop:agents:subagent", profile);
    await profile.ready;

    if (!profile.state || profile.error) throw new Error(profile.error || `Review agent unavailable: ${settings.agent}`);
    const record = await createReview(ctx, profile.state);
    pi.appendEntry("piop-review", record);
    pi.sendMessage({ customType: "piop-review-link", content: "Code review", display: true, details: record }, { triggerTurn: false });
    openReview(ctx, record, settings.prompt, images);
  };
  pi.registerCommand("review", {
    description: "Review this branch against its base in a side pane",
    handler: (args, ctx) => startReview(args, ctx),
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "start_review") return;
    request.ready = (async () => {
      const payload = Parse(reviewRequestSchema, request.payload);
      await startReview(payload.args, request.ctx, payload.images);
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

      if (record.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("This review belongs to another conversation");
      openReview(ctx, record);
    })();
  });
}
