import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUXILIARY_PARENT, canFork, isCurrent, createChat, reserveSessionId } from "../piop-storage/index.ts";
import { currentHost } from "../session-broker/index.ts";
import type { AuxiliaryCopy } from "./index.ts";

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

function lastTurnEnd(branch: Branch) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];

    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") return index;
    const pending = new Set(entry.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []));
    let end = index;

    for (let next = index + 1; pending.size && next < branch.length; next++) {
      const later = branch[next];

      if (later.type === "message" && later.message.role === "toolResult" && pending.delete(later.message.toolCallId)) end = next;
    }

    if (!pending.size) return end;
  }

  return -1;
}

export async function copyAuxiliary(ctx: ExtensionContext, copy: AuxiliaryCopy) {
  if (!canFork(ctx.sessionManager.getEntries())) throw new Error("Only main chats can have side chats");
  const branch = ctx.sessionManager.getBranch();
  const end = lastTurnEnd(branch);

  if (end < 0) throw new Error("Wait for the first agent turn to finish");
  const header = ctx.sessionManager.getHeader();
  const source = ctx.sessionManager.getSessionFile();

  if (!header || !source) throw new Error("Save this conversation before copying it");
  const history = branch.slice(0, end + 1).filter(entry => !isCurrent(entry));
  const settings = ctx.sessionManager.getEntries().filter(entry => isCurrent(entry) && !(entry.type === "custom" && entry.customType === "piop-input-hold"));
  const entries: unknown[] = structuredClone([...history, ...settings]);
  const cwd = await realpath(ctx.cwd);
  const sessionId = await reserveSessionId();
  const parentSessionId = ctx.sessionManager.getSessionId();
  const host = currentHost();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);

  entries.push(
    { type: "custom", customType: "piop-input-hold", data: { held: true }, id: randomUUID(), parentId: null, timestamp },
    { type: "custom", customType: AUXILIARY_PARENT, id: randomUUID(), parentId: history.at(-1)?.id ?? null, timestamp, data: { kind: copy.kind, sessionId, hostId: host, parentSessionId, parentHostId: host } },
  );
  await createChat({ path: sessionPath, name: copy.name, entries: [{ ...header, id: sessionId, timestamp, cwd, parentSession: source, piopForkSource: undefined }, ...entries] });

  return { hostId: host, sessionId, sessionPath, cwd, parentSessionId };
}
