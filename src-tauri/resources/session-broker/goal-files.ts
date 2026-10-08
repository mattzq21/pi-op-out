import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./goal-state.ts";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { claim, discardPreparation, rootForDirectory } from "./goal-assets.cjs";

const imageSchema = Type.Object({ data: Type.String(), mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/gif"), Type.Literal("image/webp")]) });

const attachmentSchema = Type.Object({ name: Type.String(), text: Type.Optional(Type.String()), image: Type.Optional(Type.Union([Type.Null(), imageSchema])) });

const draftSchema = Type.Object({ objective: Type.String(), attachments: Type.Array(attachmentSchema) });

export const goalImagesSchema = Type.Array(Type.Object({ data: Type.String(), mimeType: Type.String(), name: Type.Optional(Type.String()) }));

const preparationSchema = Type.Object({ version: Type.Literal(1), submissionId: Type.String(), digest: Type.String(), objective: Type.String(), sessionId: Type.String(), sessionPath: Type.Optional(Type.String()), cwd: Type.String(), goalId: Type.Optional(Type.String()), expectedState: Type.Optional(Type.String()) });

const fileErrorSchema = Type.Object({ code: Type.String() });

export type GoalPreparation = Static<typeof preparationSchema>;

type Attachment = Static<typeof attachmentSchema>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const preparationDirectory = (ctx: ExtensionContext, id: string) => join(ctx.sessionManager.getSessionDir(), "attachments", `goal-${hash(id)}`);

async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try { await directory.sync(); } finally { await directory.close(); }
}

async function syncPreparation(ctx: ExtensionContext, directory: string) {
  await syncDirectory(directory); await syncDirectory(dirname(directory)); await syncDirectory(ctx.sessionManager.getSessionDir());
}

async function writeContent(path: string, content: string | Buffer) {
  const file = await open(path, "wx", 0o600);

  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

export async function readGoalPreparation(ctx: ExtensionContext, id: string) {
  try {
    const preparation = Parse(preparationSchema, JSON.parse(await readFile(join(preparationDirectory(ctx, id), "prepared.json"), "utf8")));

    if (preparation.submissionId !== id) throw new Error("Saved goal preparation identity is inconsistent");
    validateObjective(preparation.objective);

    return preparation;
  } catch (error) { if (Check(fileErrorSchema, error) && error.code === "ENOENT") return;

  throw error; }
}

export async function goalPreparationView(ctx: ExtensionContext, id: string) {
  const preparation = await readGoalPreparation(ctx, id);

  if (!preparation) return null;

  return { ...preparation, sessionSaved: Boolean(preparation.sessionPath && existsSync(preparation.sessionPath)) };
}

function materializedGoal(preparation: GoalPreparation, directory: string, created: boolean) {
  let bound = Boolean(preparation.goalId);

  return {
    objective: preparation.objective, goalId: preparation.goalId, submissionId: preparation.submissionId,
    cleanup: async () => { if (created && !bound) discardPreparation(rootForDirectory(dirname(dirname(directory))), directory, preparation.sessionId); },
    bind: async (goalId: string, ctx: ExtensionContext, expectedState: string) => {
      const temporary = join(directory, `prepared-${randomUUID()}.tmp`);
      const next: GoalPreparation = { ...preparation, goalId, expectedState, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };

      try {
        claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, next.sessionId, next.sessionPath, next.objective);
        await writeContent(temporary, JSON.stringify(next));
        await rename(temporary, join(directory, "prepared.json"));
        bound = true;
        await syncDirectory(directory);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}

export async function loadMaterializedGoal(ctx: ExtensionContext, id: string) {
  const preparation = await readGoalPreparation(ctx, id);

  if (!preparation) throw new Error("The queued goal preparation is unavailable. Restore the original submission from saved input recovery.");
  const directory = preparationDirectory(ctx, id);
  claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), preparation.objective);
  await syncPreparation(ctx, directory);

  return materializedGoal(preparation, directory, false);
}

export async function materializeGoal(value: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = []) {
  const input = value.startsWith("__piop_draft ") ? JSON.parse(value.slice(13)) : { objective: value, attachments: [] };

  const parsed = Parse(draftSchema, input);
  const draft = Parse(draftSchema, { ...parsed, attachments: [...parsed.attachments, ...images.map((image, index) => ({ name: image.name ?? `Image ${index + 1}`, image }))] });

  if (!draft.objective.trim()) throw new Error("Goal objective must not be empty.");
  const digest = hash(JSON.stringify(draft));
  const id = submissionId ?? `content:${digest}`;
  const directory = preparationDirectory(ctx, id);
  const previous = await readGoalPreparation(ctx, id);

  if (previous) {
    if (previous.digest !== digest) throw new Error("The saved goal submission has different input. Edit the draft before sending a new goal.");
    claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), previous.objective);
    await syncPreparation(ctx, directory);

    return materializedGoal(previous, directory, false);
  }

  const root = join(ctx.sessionManager.getSessionDir(), "attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(`${directory}-pending-`);

  try {
    const objective = await saveObjective(staging, directory, draft);
    const preparation: GoalPreparation = { version: 1, submissionId: id, digest, objective, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
    await writeContent(join(staging, "prepared.json"), JSON.stringify(preparation));
    await syncDirectory(staging);
    await rename(staging, directory);
    claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, preparation.sessionId, preparation.sessionPath, preparation.objective);
    await syncPreparation(ctx, directory);

    return materializedGoal(preparation, directory, true);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function saveObjective(staging: string, directory: string, draft: Static<typeof draftSchema>) {
  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return validateObjective(draft.objective);
  const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(staging, directory, attachment, index)));
  const path = join(directory, "goal-objective.md");
  await writeContent(join(staging, "goal-objective.md"), [draft.objective, ...references].join("\n\n"));

  return validateObjective(`Read the goal objective file at ${path} before continuing.`);
}

async function saveAttachment(staging: string, directory: string, attachment: Attachment, index: number) {
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const image = attachment.image;

  const content = image ? Buffer.from(image.data, "base64") : attachment.text;

  if (content === undefined) throw new Error("Invalid goal attachment.");
  const name = `attachment-${index + 1}.${image ? extensions[image.mimeType] : "txt"}`;
  const path = join(directory, name);
  await writeContent(join(staging, name), content);

  return `${attachment.name}: ${path}. Read this file before continuing.`;
}
