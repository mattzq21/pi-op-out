import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUXILIARY_PARENT, canFork, isCurrent } from "../piop-storage/session-records.cjs";
import { reserveSessionId, writeSessionFile, type SessionPublication } from "../piop-storage/session-file.ts";
import { retainHistory, rootForDirectory } from "../piop-storage/goal-assets.cjs";
import { currentHost } from "../session-broker/client.ts";
import { releaseForkAssets, retainedFork } from "./fork.ts";
import type { AuxiliaryCopy } from "./interface.ts";

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

/**
 * The index of the last entry of the last finished agent turn: an assistant response that stopped or failed,
 * or one whose tool calls all have results. -1 when no turn has finished.
 */
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

/** SessionControls.copyAuxiliary. */
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
    { type: "custom", customType: AUXILIARY_PARENT, id: randomUUID(), parentId: history.at(-1)?.id ?? null, timestamp, data: { kind: copy.kind, sessionId, hostId: host, parentSessionId, parentHostId: host, parentSessionPath: source } },
  );
  const root = rootForDirectory(ctx.sessionManager.getSessionDir());
  let publication: SessionPublication | undefined;
  let goalAssets: ReturnType<typeof retainHistory> | undefined;

  // The copy keeps the files its history names, but gets no goal and no fork source of its own.
  try {
    goalAssets = retainHistory(root, [{ ...header, parentSession: source }, ...entries], sessionId, sessionPath);
    publication = await writeSessionFile(sessionPath, [{ ...header, id: sessionId, timestamp, cwd, parentSession: source, piopForkSource: undefined, goalAssets }, ...entries], {
      name: copy.name,
      dependencies: { workspace: { path: cwd, kind: "existing" } },
    });
  } catch (error) {
    if (retainedFork(error instanceof Error ? error : undefined, publication)) {
      throw new Error(`Side chat recovery is pending at ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    releaseForkAssets(ctx, goalAssets, sessionId, sessionPath);
    throw error;
  }

  return { hostId: host, sessionId, sessionPath, cwd, parentSessionId };
}
