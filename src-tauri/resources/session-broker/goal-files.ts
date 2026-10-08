import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./goal-state.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { acquireWorktreePublicationLock as acquireReferencePublicationLock } from "../piop-diff-watch/git.ts";

const imageSchema = Type.Object({ data: Type.String(), mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/gif"), Type.Literal("image/webp")]) });

const attachmentSchema = Type.Object({ name: Type.String(), text: Type.Optional(Type.String()), image: Type.Optional(Type.Union([Type.Null(), imageSchema])) });

const draftSchema = Type.Object({ objective: Type.String(), attachments: Type.Array(attachmentSchema) });

type Attachment = Static<typeof attachmentSchema>;

type GoalOwner = { directory: string; sessionId: string; release: () => void };

const goalOwners = new Map<string, GoalOwner>();

function ownGoalDirectory(directory: string) {
  const descriptor = openSync(join(directory, "allocation.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Invalid goal attachment ownership lock");
    const child = spawnSync("flock", ["--exclusive", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] });

    if (child.error) throw child.error;

    if (child.status !== 0) throw new Error(child.stderr.toString().trim() || "Could not own goal attachments");
    let closed = false;

    return () => {
      if (closed) return;
      closed = true; goalOwners.delete(directory); closeSync(descriptor);
    };
  } catch (error) { closeSync(descriptor); throw error; }
}

async function savedGoalReferences(ctx: ExtensionContext) {
  const session = ctx.sessionManager.getSessionFile();

  try { if (session) return await readFile(session, "utf8"); }
  catch {}

  return "";
}

function referencesGoal(content: string, directory: string) {
  return content.includes(JSON.stringify(directory).slice(1, -1));
}

export async function releaseSavedGoals(ctx: ExtensionContext, restarted = false) {
  if (!goalOwners.size) return;
  const owners = [...goalOwners.values()];
  const saved = await savedGoalReferences(ctx);
  const pending = restarted ? JSON.stringify(ctx.sessionManager.getEntries()) : "";
  const sessionId = ctx.sessionManager.getSessionId();

  for (const owner of owners) {
    const abandoned = restarted && (owner.sessionId !== sessionId || !referencesGoal(pending, owner.directory));

    if (abandoned || referencesGoal(saved, owner.directory)) owner.release();
  }
}

async function releaseAppliedGoal(prepared: GoalOwner, ctx: ExtensionContext) {
  if (referencesGoal(await savedGoalReferences(ctx), prepared.directory)) prepared.release();
  else goalOwners.set(prepared.directory, prepared);
}

async function writeGoalFile(path: string, content: string | Buffer) {
  const file = await open(path, "wx", 0o600);

  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
}

async function syncGoalDirectory(path: string) {
  const directory = await open(path, "r");

  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function markGoalAllocation() {
  const root = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
  const pending = await open(join(root, "goal-retention.pending"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!(await pending.stat()).isFile()) throw new Error("Invalid goal attachment recovery marker");
    await pending.sync();
  } finally { await pending.close(); }

  await syncGoalDirectory(root);
}

export async function materializeGoal(value: string, ctx: ExtensionContext) {
  const draft = value.startsWith("__piop_draft ") ? JSON.parse(value.slice(13)) : { objective: value, attachments: [] };

  if (!Check(draftSchema, draft)) throw new Error("Invalid goal draft or attachment.");

  if (!draft.objective.trim()) throw new Error("Goal objective must not be empty.");

  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return { objective: validateObjective(draft.objective), release: async (_applied: boolean) => {} };
  const publication = await acquireReferencePublicationLock();

  try {
    await markGoalAllocation();
    const prepared = await materializeFiles(draft, ctx);

    return { objective: prepared.objective, release: async (applied: boolean) => {
      try {
        if (applied) await releaseAppliedGoal(prepared, ctx);
        else { prepared.release(); await rm(prepared.directory, { recursive: true, force: true }); }
      }
      finally { await publication.close(); }
    } };
  } catch (error) { await publication.close(); throw error; }
}

async function materializeFiles(draft: Static<typeof draftSchema>, ctx: ExtensionContext) {
  const root = join(ctx.sessionManager.getSessionDir(), "attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "goal-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let release: (() => void) | undefined;

  try {
    release = ownGoalDirectory(directory);
    const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(directory, attachment, index)));
    const path = join(directory, "goal-objective.md");
    await writeGoalFile(path, [draft.objective, ...references].join("\n\n"));
    await syncGoalDirectory(directory);
    await syncGoalDirectory(root);
    await syncGoalDirectory(dirname(root));

    return { objective: validateObjective(`Read the goal objective file at ${path} before continuing.`), directory, sessionId: ctx.sessionManager.getSessionId(), release };
  } catch (error) { release?.(); await cleanup(); throw error; }
}

async function saveAttachment(directory: string, attachment: Attachment, index: number) {
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const image = attachment.image;

  const content = image ? Buffer.from(image.data, "base64") : attachment.text;

  if (content === undefined) throw new Error("Invalid goal attachment.");
  const path = join(directory, `attachment-${index + 1}.${image ? extensions[image.mimeType] : "txt"}`);
  await writeGoalFile(path, content);

  return `${attachment.name}: ${path}. Read this file before continuing.`;
}
