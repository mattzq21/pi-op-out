import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String() });

async function transcriptHeader(file: FileHandle, sessionId: string) {
  const buffer = Buffer.alloc(65536);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(10);

  if (end < 0) throw new Error("Conversation header is incomplete or exceeds its size limit");
  const line = buffer.subarray(0, end);
  const header = JSON.parse(line.toString("utf8"));

  if (!Check(headerSchema, header) || header.id !== sessionId) throw new Error("The transcript at this path belongs to another conversation");

  return createHash("sha256").update(line).digest("hex");
}

export async function transcriptMetadata(path: string, sessionId: string) {
  const file = await open(path, "r");

  try { return { header: await transcriptHeader(file, sessionId), size: (await file.stat()).size }; }
  finally { await file.close(); }
}

export async function* transcriptLines(path: string, start = 0, sessionId?: string, expectedHeader?: string) {
  const file = await open(path, "r");
  let input;
  let pending = Buffer.alloc(0);
  let offset = start;

  try {
    if (sessionId) {
      const header = await transcriptHeader(file, sessionId);

      if (expectedHeader && header !== expectedHeader) throw new Error("The conversation moved during usage accounting; retry with its current task boundary");
    }

    input = file.createReadStream({ start, autoClose: false });

    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk]);
      let end = pending.indexOf(10);

      while (end >= 0) {
        const next = offset + end + 1;
        yield { line: pending.subarray(0, end).toString("utf8"), offset, next };
        pending = pending.subarray(end + 1);
        offset = next;
        end = pending.indexOf(10);
      }
    }

    if (pending.length) yield { line: pending.toString("utf8"), offset, next: offset + pending.length };
  } finally { input?.destroy(); await file.close(); }
}
