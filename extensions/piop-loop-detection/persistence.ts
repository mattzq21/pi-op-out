import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "./detector.ts";

const MAX_BYTES = 512 * 1024;
const MAX_CHECKPOINTS = 16;
type Checkpoint = { anchor: string; configuration: string | null; state: Snapshot };
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
    if (data.version !== 1 || !Array.isArray(data.checkpoints)) return [];
    return data.checkpoints.slice(-MAX_CHECKPOINTS).filter((item: Checkpoint) => item && typeof item.anchor === "string" && item.state);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadCheckpoint(ctx: ExtensionContext, configuration: string | null): unknown {
  const path = file(ctx);
  if (!path) return;
  const checkpoints = read(path).filter(item => item.configuration === configuration);
  const branch = ctx.sessionManager.getBranch();
  const resumes = new Set(branch.flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "pi-desktop-resume") return [];
    const message = (entry.data as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? [message] : [];
  }));
  for (const entry of branch.reverse()) {
    const checkpoint = checkpoints.findLast(item => item.anchor === entry.id);
    if (checkpoint) return checkpoint.state;
    if (newUserInput(entry, resumes)) return;
  }
}

function newUserInput(entry: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number], resumes: Set<string>) {
  if (entry.type !== "message" || entry.message.role !== "user") return false;
  const content = entry.message.content;
  const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
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
