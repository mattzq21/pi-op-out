import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./goal-state.ts";

type Attachment = { name: string; text?: string; image?: { data: string; mimeType: string } };
export async function materializeGoal(value: string, ctx: ExtensionContext) {
  const draft: { objective: string; attachments: Attachment[] } = value.startsWith("__piop_draft ") ? JSON.parse(value.slice(13)) : { objective: value, attachments: [] };
  if (typeof draft.objective !== "string" || !draft.objective.trim() || !Array.isArray(draft.attachments)) throw new Error("Goal objective must not be empty.");
  if (!draft.attachments.length && [...draft.objective.trim()].length <= 4000) return { objective: validateObjective(draft.objective), cleanup: async () => {} };
  const root = join(ctx.sessionManager.getSessionDir(), "attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "goal-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const references = await Promise.all(draft.attachments.map((attachment, index) => saveAttachment(directory, attachment, index)));
    const path = join(directory, "goal-objective.md");
    await writeFile(path, [draft.objective, ...references].join("\n\n"), { mode: 0o600, flag: "wx" });
    return { objective: validateObjective(`Read the goal objective file at ${path} before continuing.`), cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function saveAttachment(directory: string, attachment: Attachment, index: number) {
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const image = attachment.image;
  if (image && (!extensions[image.mimeType] || typeof image.data !== "string")) throw new Error("Unsupported goal image.");
  if (!image && typeof attachment.text !== "string") throw new Error("Invalid goal attachment.");
  const path = join(directory, `attachment-${index + 1}.${image ? extensions[image.mimeType] : "txt"}`);
  await writeFile(path, image ? Buffer.from(image.data, "base64") : attachment.text!, { mode: 0o600, flag: "wx" });
  return `${attachment.name}: ${path}. Read this file before continuing.`;
}
