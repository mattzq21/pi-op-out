import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./goal-state.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const imageSchema = Type.Object({ data: Type.String(), mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/gif"), Type.Literal("image/webp")]) });

const attachmentSchema = Type.Object({ name: Type.String(), text: Type.Optional(Type.String()), image: Type.Optional(Type.Union([Type.Null(), imageSchema])) });

const draftSchema = Type.Object({ objective: Type.String(), attachments: Type.Array(attachmentSchema) });

type Attachment = Static<typeof attachmentSchema>;

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

export async function materializeGoal(value: string, ctx: ExtensionContext) {
  const draft = value.startsWith("__piop_draft ") ? JSON.parse(value.slice(13)) : { objective: value, attachments: [] };

  if (!Check(draftSchema, draft)) throw new Error("Invalid goal draft or attachment.");

  if (!draft.objective.trim()) throw new Error("Goal objective must not be empty.");

  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return { objective: validateObjective(draft.objective), cleanup: async () => {} };
  const root = join(ctx.sessionManager.getSessionDir(), "attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "goal-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });

  try {
    const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(directory, attachment, index)));
    const path = join(directory, "goal-objective.md");
    await writeGoalFile(path, [draft.objective, ...references].join("\n\n"));
    await syncGoalDirectory(directory);
    await syncGoalDirectory(root);
    await syncGoalDirectory(dirname(root));

    return { objective: validateObjective(`Read the goal objective file at ${path} before continuing.`), cleanup };
  } catch (error) { await cleanup(); throw error; }
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
