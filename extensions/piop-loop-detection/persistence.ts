import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshotSchema, type Snapshot } from "./detector.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const MAX_BYTES = 512 * 1024;

const MAX_CHECKPOINTS = 16;

const checkpointSchema = Type.Object({ anchor: Type.String(), configuration: Type.Optional(Type.Union([Type.String(), Type.Null()])), state: Type.Unknown() });

type Checkpoint = Static<typeof checkpointSchema>;

const checkpointFileSchema = Type.Object({ version: Type.Literal(1), checkpoints: Type.Array(Type.Unknown()) });

const resumeSchema = Type.Object({ message: Type.String() });

const file = (ctx: ExtensionContext) => {
  const session = ctx.sessionManager.getSessionFile();

  return session ? `${session}.loop-detection.json` : undefined;
};

function read(path: string): Checkpoint[] {
  let fd: number | undefined;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);

    if (size > MAX_BYTES) return [];
    const data = JSON.parse(buffer.subarray(0, size).toString("utf8"));

    if (!Check(checkpointFileSchema, data)) return [];

    return data.checkpoints.slice(-MAX_CHECKPOINTS).flatMap(item => Check(checkpointSchema, item) && item.state ? [item] : []);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadCheckpoint(ctx: ExtensionContext, configuration: string | null): Snapshot | undefined {
  const path = file(ctx);

  if (!path) return;
  const checkpoints = read(path).filter(item => item.configuration === configuration);
  const branch = ctx.sessionManager.getBranch();

  const resumes = new Set(branch.flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "pi-desktop-resume") return [];

    return Check(resumeSchema, entry.data) ? [entry.data.message] : [];
  }));

  for (const entry of branch.reverse()) {
    const checkpoint = checkpoints.findLast(item => item.anchor === entry.id);

    if (checkpoint) return Check(snapshotSchema, checkpoint.state) ? checkpoint.state : undefined;

    if (newUserInput(entry, resumes)) return;
  }
}

function newUserInput(entry: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number], resumes: Set<string>) {
  if (entry.type !== "message" || entry.message.role !== "user") return false;
  const content = entry.message.content;
  const text = Array.isArray(content) ? content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : content;

  return !resumes.has(text);
}

export function saveCheckpoint(ctx: ExtensionContext, configuration: string | null, state: Snapshot) {
  const path = file(ctx);
  const anchor = ctx.sessionManager.getLeafId();

  if (!path || !anchor) return;
  const checkpoints = [...read(path).filter(item => item.anchor !== anchor), { anchor, configuration, state }].slice(-MAX_CHECKPOINTS);
  let data = JSON.stringify({ version: 1, checkpoints });

  while (Buffer.byteLength(data) > MAX_BYTES && checkpoints.length > 1) {
    checkpoints.shift(); data = JSON.stringify({ version: 1, checkpoints });
  }

  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Loop detection checkpoint exceeds its size limit");
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { }
  }
}
