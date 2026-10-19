import { lockSync as lockSync } from "../file-lock.cjs";
import { begin as beginDirectoryRecovery, finish as finishDirectoryRecovery, recoverPublished } from "./goal-directory-recovery.cjs";
import { read as readDependencies, textContents, savePreparedText, removePreparedText } from "./goal-dependencies.cjs";
import { markCleanup } from "../session-database.cjs";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "../piop-goals/state.ts";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import { read as readPreparation } from "./goal-prepared-files.cjs";
import { save as savePreparation } from "./goal-preparations.cjs";
import { allocate as allocateGoalDirectory } from "./goal-ownership.cjs";
import { acquire as acquireGoalAssets, exists as goalDirectoryExists, claim, directReferences, validPath, discardPreparation, rootForDirectory } from "./goal-assets.cjs";
import { acquireReferencePublicationLockAsync } from "./reference-publication-lock.cjs";
import { homedir } from "node:os";

const imageSchema = Type.Object({ data: Type.String(), mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/gif"), Type.Literal("image/webp")]) });

const attachmentSchema = Type.Object({ name: Type.String(), text: Type.Optional(Type.String()), image: Type.Optional(Type.Union([Type.Null(), imageSchema])) });

const draftSchema = Type.Object({ objective: Type.String(), attachments: Type.Array(attachmentSchema) });

const savedFileSchema = Type.Object({ name: Type.String({ pattern: "^(?:goal-objective\\.md|attachment-[1-9][0-9]*\\.(?:txt|png|jpg|gif|webp))$" }), data: Type.String(), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) });

export const goalImagesSchema = Type.Array(Type.Object({ data: Type.String(), mimeType: Type.String(), name: Type.Optional(Type.String()) }));

const preparationSchema = Type.Object({ version: Type.Literal(1), submissionId: Type.String(), digest: Type.String(), objective: Type.String(), sessionId: Type.String(), sessionPath: Type.Optional(Type.String()), cwd: Type.String(), goalId: Type.Optional(Type.String()), expectedState: Type.Optional(Type.String()), input: Type.Optional(draftSchema), files: Type.Optional(Type.Array(savedFileSchema)) });

export type GoalPreparation = Static<typeof preparationSchema>;

type Attachment = Static<typeof attachmentSchema>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const preparationDirectory = (ctx: ExtensionContext, id: string) => join(ctx.sessionManager.getSessionDir(), "attachments", `goal-${hash(id)}`);

async function withGoalPublication<T>(operation: () => Promise<T>) {
  const publication = await acquireReferencePublicationLockAsync(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"));

  try { return await operation(); }
  finally { publication(); }
}

function ownGoalDirectory(directory: string) {
  const descriptor = openSync(join(directory, "allocation.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Invalid goal attachment ownership lock");
    const child = lockSync(descriptor, false, false);

    if (!child) throw new Error("Could not own goal attachments");

    return () => closeSync(descriptor);
  } catch (error) { closeSync(descriptor); throw error; }
}

async function markGoalAllocation(ctx: ExtensionContext) {
  const root = rootForDirectory(ctx.sessionManager.getSessionDir());
  markCleanup(root, "goal");
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try { await directory.sync(); } finally { await directory.close(); }
}

async function syncPreparation(ctx: ExtensionContext, directory: string) {
  await syncDirectory(directory); await syncDirectory(dirname(directory)); await syncDirectory(ctx.sessionManager.getSessionDir());
}

async function writeContent(path: string, content: string | Buffer, restore = false) {
  if (restore && await existingContent(path, content)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    await file.writeFile(content); await file.sync();
    await link(temporary, path);
  } finally { await file.close(); await rm(temporary, { force: true }); }
}

async function existingContent(path: string, content: string | Buffer) {
  let file;

  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }

  try {
    if (!(await file.stat()).isFile()) throw new Error("Goal attachment is not a regular file");

    const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);

    if (!(await file.readFile()).equals(expected)) throw new Error("Goal attachment differs from the saved input");

    return true;
  } finally { await file.close(); }
}

async function restoreGoalFiles(preparation: GoalPreparation, directory: string, destination = directory) {
  if (!preparation.input) return restoreSavedFiles(preparation, directory);

  if (hash(JSON.stringify(preparation.input)) !== preparation.digest) throw new Error("Saved goal input changed");
  const release = ownGoalDirectory(directory);

  try {
    const saved = await saveObjective(directory, destination, preparation.input, true);

    if (saved.objective !== preparation.objective) throw new Error("Saved goal objective does not match its input");
  } finally { release(); }
}

async function restoreSavedFiles(preparation: GoalPreparation, directory: string) {
  if (!preparation.files) return;
  const release = ownGoalDirectory(directory);

  try {
    for (const file of preparation.files) {
      const content = Buffer.from(file.data, "base64");

      if (createHash("sha256").update(content).digest("hex") !== file.digest) throw new Error("Saved goal attachment contents changed");
      await writeContent(join(directory, file.name), content, true);
    }
  } finally { release(); }
}

async function restoreGoalDirectory(ctx: ExtensionContext, preparation: GoalPreparation, directory: string) {
  const root = rootForDirectory(ctx.sessionManager.getSessionDir());
  const release = acquireGoalAssets(root);

  try {
    if (existsSync(directory)) { await restoreGoalFiles(preparation, directory);

    return; }

    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    const recovery = beginDirectoryRecovery(root, directory);
    const saved = Parse(preparationSchema, JSON.parse(recovery.preparation));
    await restoreGoalFiles(saved, recovery.staging, directory);
    await syncDirectory(recovery.staging);

    if (goalDirectoryExists(directory)) throw new Error("Goal recovery destination already exists");
    await rename(recovery.staging, directory);
    finishDirectoryRecovery(root, directory);
  } finally { release(); }
}

function retainGoalInput(ctx: ExtensionContext, preparation: GoalPreparation, directory: string, input: Static<typeof draftSchema>) {
  if (preparation.input) return;
  preparation.input = input;
  savePreparation(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, preparation);
}

export async function readGoalPreparation(ctx: ExtensionContext, id: string) {
  const root = rootForDirectory(ctx.sessionManager.getSessionDir());
  recoverPublished(root, preparationDirectory(ctx, id));
  const saved = readPreparation(root, preparationDirectory(ctx, id));

  if (saved === undefined) return;
  const preparation = Parse(preparationSchema, saved);

  if (preparation.submissionId !== id) throw new Error("Saved goal preparation identity is inconsistent");
  validateObjective(preparation.objective);

  return preparation;
}

export async function goalPreparationView(ctx: ExtensionContext, id: string) {
  const preparation = await readGoalPreparation(ctx, id);

  if (!preparation) return null;

  const { input: _input, files: _files, ...view } = preparation;

  return { ...view, sessionSaved: Boolean(preparation.sessionPath && existsSync(preparation.sessionPath)) };
}

function materializedGoal(preparation: GoalPreparation, directory: string, created: boolean) {
  let bound = Boolean(preparation.goalId);

  return {
    objective: preparation.objective, goalId: preparation.goalId, submissionId: preparation.submissionId,
    cleanup: () => withGoalPublication(async () => { if (created && !bound) discardPreparation(rootForDirectory(dirname(dirname(directory))), directory, preparation.sessionId); }),
    bind: (goalId: string, ctx: ExtensionContext, expectedState: string) => withGoalPublication(async () => {
      const next: GoalPreparation = { ...preparation, goalId, expectedState, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
      const root = rootForDirectory(ctx.sessionManager.getSessionDir());
      claim(root, directory, next.sessionId, next.sessionPath, next.objective);
      savePreparation(root, directory, next);
      bound = true;
    }),
  };
}

export async function restoreGoalAttachments(ctx: ExtensionContext, objective: string) {
  const root = rootForDirectory(ctx.sessionManager.getSessionDir());
  const directories = directReferences([objective], root);

  if (!directories.size) return;
  await withGoalPublication(async () => {
    for (const directory of directories) {
      if (!validPath(root, directory)) throw new Error("Goal attachment is outside shared storage");
      recoverPublished(root, directory);
      const record = readPreparation(root, directory);

      if (record !== undefined) await restoreGoalDirectory(ctx, Parse(preparationSchema, record), directory);
      const dependencies = readDependencies(root, directory);

      for (const dependency of dependencies?.directories ?? []) directories.add(dependency.path);

      for (const dependency of directReferences(textContents(root, directory).map(entry => entry.text), root)) directories.add(dependency);
    }

    claim(root, [...directories][0], ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), objective);
  });
}

export async function loadMaterializedGoal(ctx: ExtensionContext, id: string) {
  return withGoalPublication(() => loadPreparedGoal(ctx, id));
}

async function loadPreparedGoal(ctx: ExtensionContext, id: string) {
  const preparation = await readGoalPreparation(ctx, id);

  if (!preparation) throw new Error("The queued goal preparation is unavailable. Restore the original submission from saved input recovery.");
  const directory = preparationDirectory(ctx, id);
  await restoreGoalDirectory(ctx, preparation, directory);
  claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), preparation.objective);
  await syncPreparation(ctx, directory);

  return materializedGoal(preparation, directory, false);
}

export async function materializeGoal(value: string, ctx: ExtensionContext, submissionId?: string, images: Static<typeof goalImagesSchema> = []) {
  return withGoalPublication(() => materializeLocked(value, ctx, submissionId, images));
}

async function materializeLocked(value: string, ctx: ExtensionContext, submissionId: string | undefined, images: Static<typeof goalImagesSchema>) {
  const input = value.startsWith("__piop_draft ") ? JSON.parse(value.slice(13)) : { objective: value, attachments: [] };

  const parsed = Parse(draftSchema, input);

  if (parsed.attachments.length || images.length) throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
  const draft = parsed;

  if (!draft.objective.trim()) throw new Error("Goal objective must not be empty.");
  const digest = hash(JSON.stringify(draft));
  const id = submissionId ?? `content:${digest}`;
  const directory = preparationDirectory(ctx, id);
  const previous = await readGoalPreparation(ctx, id);

  if (previous) {
    if (previous.digest !== digest) throw new Error("The saved goal submission has different input. Edit the draft before sending a new goal.");
    await restoreGoalDirectory(ctx, previous, directory);
    retainGoalInput(ctx, previous, directory, draft);
    claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), previous.objective);
    await syncPreparation(ctx, directory);

    return materializedGoal(previous, directory, false);
  }

  const root = join(ctx.sessionManager.getSessionDir(), "attachments");
  await markGoalAllocation(ctx);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const profile = rootForDirectory(ctx.sessionManager.getSessionDir());
  const allocation = allocateGoalDirectory(profile, root);
  const staging = allocation.directory;
  let savedIdentity: string | undefined;
  let published = false;
  let release: (() => void) | undefined;

  try {
    release = ownGoalDirectory(staging);
    const { objective, textFiles } = await saveObjective(staging, directory, draft);
    const preparation: GoalPreparation = { version: 1, submissionId: id, digest, objective, input: draft, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
    savedIdentity = savePreparedText(profile, staging, textFiles, JSON.stringify(preparation), directory);
    await syncDirectory(staging);
    await rename(staging, directory);
    published = true;
    claim(rootForDirectory(ctx.sessionManager.getSessionDir()), directory, preparation.sessionId, preparation.sessionPath, preparation.objective);
    await syncPreparation(ctx, directory);

    return materializedGoal(preparation, directory, true);
  } finally {
    release?.();
    await rm(staging, { recursive: true, force: true });
    removePreparedText(profile, staging, allocation.identity);

    if (!published && savedIdentity) {
      removePreparedText(profile, directory, savedIdentity);
    }
  }
}

async function saveObjective(staging: string, directory: string, draft: Static<typeof draftSchema>, restore = false) {
  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return { objective: validateObjective(draft.objective), textFiles: [] };
  const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(staging, directory, attachment, index, restore)));
  const path = join(directory, "goal-objective.md");
  await writeContent(join(staging, "goal-objective.md"), [draft.objective, ...references].join("\n\n"), restore);

  return {
    objective: validateObjective(`Read the goal objective file at ${path} before continuing.`),
    textFiles: ["goal-objective.md", ...draft.attachments.flatMap((attachment, index) => attachment.image ? [] : [`attachment-${index + 1}.txt`])],
  };
}

async function saveAttachment(staging: string, directory: string, attachment: Attachment, index: number, restore: boolean) {
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const image = attachment.image;

  const content = image ? Buffer.from(image.data, "base64") : attachment.text;

  if (content === undefined) throw new Error("Invalid goal attachment.");
  const name = `attachment-${index + 1}.${image ? extensions[image.mimeType] : "txt"}`;
  const path = join(directory, name);
  await writeContent(join(staging, name), content, restore);

  return `${attachment.name}: ${path}. Read this file before continuing.`;
}
