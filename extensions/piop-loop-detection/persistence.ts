import { read, update } from "./storage.cjs";
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

function checkpointsFrom(body: string | null): Checkpoint[] {
  if (body === null || Buffer.byteLength(body) > MAX_BYTES) return [];

  try {
    const data = JSON.parse(body);

    if (!Check(checkpointFileSchema, data)) return [];

    return data.checkpoints.slice(-MAX_CHECKPOINTS).flatMap(item => Check(checkpointSchema, item) && item.state ? [item] : []);
  } catch { return []; }
}

export function loadCheckpoint(ctx: ExtensionContext, configuration: string | null): Snapshot | undefined {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) return;
  const checkpoints = checkpointsFrom(read(path, ctx.sessionManager.getSessionId())).filter(item => item.configuration === configuration);
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
  const path = ctx.sessionManager.getSessionFile();
  const anchor = ctx.sessionManager.getLeafId();

  if (!path || !anchor) return;
  update(path, ctx.sessionManager.getSessionId(), (body: string | null) => {
    const checkpoints = [...checkpointsFrom(body).filter(item => item.anchor !== anchor), { anchor, configuration, state }].slice(-MAX_CHECKPOINTS);
    let data = JSON.stringify({ version: 1, checkpoints });

    while (Buffer.byteLength(data) > MAX_BYTES && checkpoints.length > 1) {
      checkpoints.shift(); data = JSON.stringify({ version: 1, checkpoints });
    }

    return data;
  });
}
