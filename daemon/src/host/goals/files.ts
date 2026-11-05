import * as StorageLocks from "../../../resources/storage-locks.ts";
import { begin as beginDirectoryRecovery, finish as finishDirectoryRecovery, recoverPublished } from "../../../resources/piop-storage/goal-directory-recovery.ts";
import { read as readDependencies, textContents, savePreparedText, removePreparedText } from "../../../resources/piop-storage/goal-dependencies.ts";
import { markCleanup } from "../../../resources/session-database.ts";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePreparation, read as readPreparation, save as savePreparation, type GoalAttachment, type GoalDraft, type GoalPreparation } from "../../../resources/piop-storage/goal-preparations.ts";
import { allocate as allocateGoalDirectory } from "../../../resources/piop-storage/goal-ownership.ts";
import { acquire as acquireGoalAssets, exists as goalDirectoryExists, claim, directReferences, validPath, discardPreparation, rootForDirectory } from "../../../resources/piop-storage/goal-assets.ts";
import { acquireReferencePublicationLockAsync } from "../../../resources/piop-storage/reference-publication-lock.ts";
import { requestRetention } from "../../storage";

export interface GoalPlace { file: string; sessionId: string; cwd: string }

export function validateObjective(value: string) {
  const objective = value.trim();
  if (!objective || [...objective].length > 4000) throw new Error("Goal objective must contain 1–4,000 characters. Reference a file for longer instructions.");
  return objective;
}

export type { GoalPreparation };


const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const sessionDir = (place: GoalPlace) => dirname(place.file);

const storageRoot = (place: GoalPlace) => rootForDirectory(sessionDir(place));

const preparationDirectory = (place: GoalPlace, id: string) => join(sessionDir(place), "attachments", `goal-${hash(id)}`);

async function withGoalPublication<T>(place: GoalPlace, operation: () => Promise<T>) {
  const publication = await acquireReferencePublicationLockAsync(storageRoot(place));

  try { return await operation(); }
  finally { publication(); }
}

// Keeps deferred cleanup away from goal attachments while they are prepared, under each path that they have meanwhile.
function ownGoalDirectory(...directories: string[]) {
  const releases: Array<() => void> = [];

  try {
    for (const directory of directories) releases.push(StorageLocks.lockSync("goal-allocation:" + directory, { busy: "Goal attachments are being cleaned up. Try again." })!);
  } catch (error) { for (const release of releases.reverse()) release(); throw error; }

  return () => { for (const release of releases.reverse()) release(); };
}

function markGoalAllocation(place: GoalPlace) {
  markCleanup(storageRoot(place), "goal");
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try { await directory.sync(); } finally { await directory.close(); }
}

async function syncPreparation(place: GoalPlace, directory: string) {
  await syncDirectory(directory); await syncDirectory(dirname(directory)); await syncDirectory(sessionDir(place));
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
  const release = ownGoalDirectory(...new Set([directory, destination]));

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

async function restoreGoalDirectory(place: GoalPlace, preparation: GoalPreparation, directory: string) {
  const root = storageRoot(place);
  const release = acquireGoalAssets(root);

  try {
    if (existsSync(directory)) { await restoreGoalFiles(preparation, directory);

    return; }

    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    const recovery = beginDirectoryRecovery(root, directory);
    const saved = parsePreparation(recovery.preparation);
    await restoreGoalFiles(saved, recovery.staging, directory);
    await syncDirectory(recovery.staging);

    if (goalDirectoryExists(directory)) throw new Error("Goal recovery destination already exists");
    await rename(recovery.staging, directory);
    finishDirectoryRecovery(root, directory);
  } finally { release(); }
}

function retainGoalInput(place: GoalPlace, preparation: GoalPreparation, directory: string, input: GoalDraft) {
  if (preparation.input) return;
  preparation.input = input;
  savePreparation(storageRoot(place), directory, preparation);
}

async function readGoalPreparation(place: GoalPlace, id: string) {
  const root = storageRoot(place);
  recoverPublished(root, preparationDirectory(place, id));
  const saved = readPreparation(root, preparationDirectory(place, id));

  if (saved === undefined) return;
  const preparation = saved;

  if (preparation.submissionId !== id) throw new Error("Saved goal preparation identity is inconsistent");
  validateObjective(preparation.objective);

  return preparation;
}

export async function goalPreparationView(place: GoalPlace, id: string) {
  const preparation = await readGoalPreparation(place, id);

  if (!preparation) return null;

  const { input: _input, files: _files, ...view } = preparation;

  return { ...view, sessionSaved: Boolean(preparation.sessionPath && existsSync(preparation.sessionPath)) };
}

function materializedGoal(place: GoalPlace, preparation: GoalPreparation, directory: string, created: boolean) {
  let bound = Boolean(preparation.goalId);

  return {
    objective: preparation.objective,
    cleanup: () => withGoalPublication(place, async () => { if (created && !bound) discardPreparation(storageRoot(place), directory, preparation.sessionId); }),
    bind: (goalId: string) => withGoalPublication(place, async () => {
      const next: GoalPreparation = { ...preparation, goalId, sessionId: place.sessionId, sessionPath: place.file, cwd: place.cwd };
      const root = storageRoot(place);
      claim(root, directory, next.sessionId, next.sessionPath, next.objective);
      savePreparation(root, directory, next);
      bound = true;
    }),
  };
}

export async function restoreGoalAttachments(place: GoalPlace, objective: string) {
  const root = storageRoot(place);
  const directories = directReferences([objective], root);

  if (!directories.size) return;
  await withGoalPublication(place, async () => {
    for (const directory of directories) {
      if (!validPath(root, directory)) throw new Error("Goal attachment is outside shared storage");
      recoverPublished(root, directory);
      const record = readPreparation(root, directory);

      if (record !== undefined) await restoreGoalDirectory(place, record, directory);
      const dependencies = readDependencies(root, directory);

      for (const dependency of dependencies?.directories ?? []) directories.add(dependency.path);

      for (const dependency of directReferences(textContents(root, directory).map(entry => entry.text), root)) directories.add(dependency);
    }

    claim(root, [...directories][0], place.sessionId, place.file, objective);
  });
}

export async function materializeGoal(place: GoalPlace, value: string, submissionId?: string) {
  return withGoalPublication(place, () => materializeLocked(place, value, submissionId));
}

async function materializeLocked(place: GoalPlace, value: string, submissionId: string | undefined) {
  const draft = { objective: value, attachments: [] as GoalAttachment[] };

  if (!draft.objective.trim()) throw new Error("Goal objective must not be empty.");
  const digest = hash(JSON.stringify(draft));
  const id = submissionId ?? `content:${digest}`;
  const directory = preparationDirectory(place, id);
  const previous = await readGoalPreparation(place, id);

  if (previous) {
    if (previous.digest !== digest) throw new Error("The saved goal submission has different input. Edit the draft before sending a new goal.");
    await restoreGoalDirectory(place, previous, directory);
    retainGoalInput(place, previous, directory, draft);
    claim(storageRoot(place), directory, place.sessionId, place.file, previous.objective);
    await syncPreparation(place, directory);

    return materializedGoal(place, previous, directory, false);
  }

  const root = join(sessionDir(place), "attachments");
  markGoalAllocation(place);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const profile = storageRoot(place);
  const allocation = allocateGoalDirectory(profile, root);
  const staging = allocation.directory;
  let savedIdentity: string | undefined;
  let published = false;
  let release: (() => void) | undefined;

  try {
    release = ownGoalDirectory(staging, directory);
    const { objective, textFiles } = await saveObjective(staging, directory, draft);
    const preparation: GoalPreparation = { version: 1, submissionId: id, digest, objective, input: draft, sessionId: place.sessionId, sessionPath: place.file, cwd: place.cwd };
    savedIdentity = savePreparedText(profile, staging, textFiles, JSON.stringify(preparation), directory);
    await syncDirectory(staging);
    await rename(staging, directory);
    published = true;
    claim(profile, directory, preparation.sessionId, preparation.sessionPath, preparation.objective);
    await syncPreparation(place, directory);

    return materializedGoal(place, preparation, directory, true);
  } finally {
    release?.();
    await rm(staging, { recursive: true, force: true });
    removePreparedText(profile, staging, allocation.identity);
    // The goal cleanup request can end now, or collect what a failed preparation left.
    requestRetention(profile);

    if (!published && savedIdentity) {
      removePreparedText(profile, directory, savedIdentity);
    }
  }
}

async function saveObjective(staging: string, directory: string, draft: GoalDraft, restore = false) {
  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return { objective: validateObjective(draft.objective), textFiles: [] };
  const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(staging, directory, attachment, index, restore)));
  const path = join(directory, "goal-objective.md");
  await writeContent(join(staging, "goal-objective.md"), [draft.objective, ...references].join("\n\n"), restore);

  return {
    objective: validateObjective(`Read the goal objective file at ${path} before continuing.`),
    textFiles: ["goal-objective.md", ...draft.attachments.flatMap((attachment, index) => attachment.image ? [] : [`attachment-${index + 1}.txt`])],
  };
}

async function saveAttachment(staging: string, directory: string, attachment: GoalAttachment, index: number, restore: boolean) {
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const image = attachment.image;

  const content = image ? Buffer.from(image.data, "base64") : attachment.text;

  if (content === undefined) throw new Error("Invalid goal attachment.");
  const name = `attachment-${index + 1}.${image ? extensions[image.mimeType] : "txt"}`;
  const path = join(directory, name);
  await writeContent(join(staging, name), content, restore);

  return `${attachment.name}: ${path}. Read this file before continuing.`;
}
