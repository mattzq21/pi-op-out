import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { createChat, reserveSessionId, AUXILIARY_PARENT, auxiliaryParent, records, chatChildren, readApplicationJson } from "../../../daemon/resources/piop-storage/index.ts";
import type { SessionAgentState, SubagentProfileRequest } from "../../../pi-extensions/piop-define-agents/contracts.ts";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { currentHost, childFastModeEntry, locateConversation, openAuxiliaryChat } from "../../../daemon/resources/session-broker/index.ts";
import type { ReviewImage, ReviewSession } from "./interface.ts";
import reviewPrompt from "./review-prompt.txt";

const reviewSchema = Schema.Object({ kind: Schema.Literal("review"), sessionId: Schema.String(), sessionPath: Schema.String(), cwd: Schema.String(), parentSessionId: Schema.String(), hostId: Schema.Optional(Schema.String()), scope: Schema.Optional(Schema.String()) });

const settingsSchema = Schema.Object({ reviewAgent: Schema.Optional(Schema.String()) });

const fileErrorSchema = Schema.Object({ code: Schema.String() });

const sessionHeaderSchema = Schema.Object({ type: Schema.Literal("session"), id: Schema.String() });

type ReviewRecord = Static<typeof reviewSchema>;

// The message in the main conversation that opens the review. As an auxiliary link, the database keeps it.
const LINK_MESSAGE = { customType: "piop-review-link", content: "Code review" };

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

function reviewName(ctx: ExtensionContext, parentPath: string, scope: string | undefined) {
  if (scope) return `Review ${scope}`;
  const reviews = chatChildren(parentPath, ctx.sessionManager.getSessionId()).filter(child => child.kind === "review");
  const unscoped = reviews.filter(child => !auxiliaryParent(records(parentPath, child.sessionId).map(record => record.entry), child.sessionId)?.scope).length;

  return `Review ${unscoped + 1}`;
}

async function createReview(pi: ExtensionAPI, ctx: ExtensionContext, agentState: SessionAgentState, scope: string | undefined, signal?: AbortSignal) {
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
  const record: ReviewRecord & { hostId: string } = { kind: "review", sessionId, sessionPath: join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(), ...scope ? { scope } : {} };
  const name = reviewName(ctx, parentSessionPath, scope);
  const metadataId = randomUUID();
  signal?.throwIfAborted();

  await createChat({ path: record.sessionPath, name, entries: [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "custom", id: metadataId, parentId: null, timestamp, customType: AUXILIARY_PARENT, data: { kind: "review", parentSessionId: record.parentSessionId, sessionId, hostId: record.hostId, parentHostId: record.hostId, ...scope ? { scope } : {} } },
    { type: "custom", id: `${metadataId}-agent`, parentId: metadataId, timestamp, customType: "pi-define-agents-state", data: agentState },
    ...fastMode ? [{ ...fastMode, id: `${metadataId}-fast-mode`, parentId: `${metadataId}-agent`, timestamp }] : [],
  ] });
  // During a reply, Pi adds the link after it.
  const { sessionPath: _path, ...link } = record;
  pi.sendMessage({ ...LINK_MESSAGE, display: true, details: { ...link, auxiliaryLink: true } }, { triggerTurn: false });

  return { record, name };
}

async function openReview(ctx: ExtensionContext, record: ReviewRecord, name: string, task: string, images: ReviewImage[] | undefined, background: boolean) {
  const hostId = record.hostId ?? currentHost();
  const location = await locateConversation(record.sessionId, hostId);

  openAuxiliaryChat(ctx, { kind: "review", name, sessionId: record.sessionId, sessionPath: location.sessionPath, cwd: location.cwd, hostId, parentSessionId: record.parentSessionId, task, ...images?.length ? { images } : {}, ...background ? { background: true } : {} });
}

async function reviewSettings() {
  const settings = Parse(settingsSchema, readApplicationJson(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"), "settings")?.plugins?.review ?? {});

  const agent = settings.reviewAgent?.trim() || "reviewer";
  return { agent, prompt: reviewPrompt };
}

async function reviewProfile(pi: ExtensionAPI, agent: string) {
  const profile: SubagentProfileRequest = { agent };
  pi.events.emit("piop:agents:subagent", profile);
  await profile.ready;

  if (!profile.state || profile.error) throw new Error(profile.error || `Review agent unavailable: ${agent}`);

  return profile.state;
}

export function registerReviews(pi: ExtensionAPI): ReviewSession {
  const unsubscribe = pi.events.on("piop:auxiliary:kind", request => { if (request.kind === "review") request.sendToMain = "Send the review result to agent whose work you reviewed, when user asks"; });
  pi.on("session_shutdown", () => { unsubscribe(); });

  return {
    async start(ctx, request) {
      const signal = ctx.signal;
      signal?.throwIfAborted();
      const settings = await reviewSettings();
      signal?.throwIfAborted();
      const profile = await reviewProfile(pi, settings.agent);
      signal?.throwIfAborted();

      const prompt = `${settings.prompt.trimEnd()}\n\n${request.scope?.trim() ? `Review ${request.scope.trim()}` : "Review the scope affected since last branch off."}`;

      const { record, name } = await createReview(pi, ctx, profile, request.scope?.trim() || undefined, signal);
      signal?.throwIfAborted();
      await openReview(ctx, record, name, prompt, request.images, Boolean(request.scope?.trim()));
    },
  };
}
