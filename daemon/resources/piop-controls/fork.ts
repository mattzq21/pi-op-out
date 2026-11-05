import { randomUUID } from "node:crypto";
import { canFork, isCurrent } from "../piop-storage/session-records.ts";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath, mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { currentHost } from "../session-broker/client.ts";
import { createFork, reserveSessionId } from "../piop-storage/session-file.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { sessionName } from "../session-broker/session-names.ts";
import type { ForkMode, ForkResult } from "./interface.ts";

export type ForkOptions = { cwd?: string; entryId?: string; position?: "before" | "at" };

const fileErrorSchema = Type.Object({ code: Type.String() });

function userText(ctx: ExtensionContext, entryId?: string) {
  const selected = entryId ? ctx.sessionManager.getEntry(entryId) : undefined;

  if (selected?.type !== "message" || selected.message.role !== "user") return;
  const content = selected.message.content;

  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("") : content;
}

export async function forkSession(ctx: ExtensionContext, mode: ForkMode, entryId?: string): Promise<ForkResult> {
  assertForkable(ctx);
  if (mode !== "clone" && !entryId) throw new Error("Select a message to branch from");
  const selected = mode === "clone" ? ctx.sessionManager.getLeafId() ?? undefined : entryId;
  const text = mode === "fork" ? userText(ctx, selected) : undefined;
  const position = mode === "fork" ? "before" : mode === "clone" ? "at" : undefined;
  const fork = await forkConversation(ctx, { entryId: selected, position });

  return { ...fork, text };
}

export async function rewindMessage(ctx: ExtensionCommandContext, entryId: string, keep: number[]) {
  if (!canFork(ctx.sessionManager.getEntries())) throw new Error("Only main chats can be edited");

  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response and queued messages to finish first");
  const entry = ctx.sessionManager.getBranch().find(item => item.id === entryId);

  if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("This message is no longer in the conversation. Reload the conversation and try again.");
  const content = entry.message.content;
  const images = Array.isArray(content) ? content.filter(part => part.type === "image") : [];

  if (keep.some(index => images[index] === undefined) || new Set(keep).size !== keep.length) throw new Error("The edited message keeps an image that the message does not have");
  const { cancelled } = await ctx.navigateTree(entryId);

  return cancelled ? { cancelled } : { cancelled, images: keep.map(index => structuredClone(images[index])) };
}

export async function forkConversation(ctx: ExtensionContext, options: ForkOptions) {
  assertForkable(ctx);
  const selected = options.position ? positionedHistory(ctx, options.entryId, options.position) : forkHistory(ctx, options.entryId);
  const retained = structuredClone([...selected.filter(entry => !isCurrent(entry)), ...ctx.sessionManager.getEntries().filter(entry => isCurrent(entry) && !(entry.type === "custom" && entry.customType === "piop-input-hold"))]);
  const header = ctx.sessionManager.getHeader();
  const source = ctx.sessionManager.getSessionFile();

  if (!header || !source) throw new Error("Save this conversation before forking it");
  const cwd = await forkDirectory(ctx.cwd, options);

  const sessionId = await reserveSessionId();
  const timestamp = new Date().toISOString();
  retained.push({ type: "custom", customType: "piop-input-hold", data: { held: true }, id: randomUUID(), parentId: null, timestamp });
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const piopForkSource = options.entryId ? { sessionId: header.id, sessionPath: source, entryId: options.entryId } : undefined;
  const name = sessionName(source, header.id);

  try {
    await createFork({
      path: sessionPath, entries: [{ ...header, id: sessionId, timestamp, cwd, parentSession: source, piopForkSource }, ...retained],
      ...name ? { name } : {}, goalSource: header.id, source: header.id, cutoff: selected.filter(entry => !isCurrent(entry)).at(-1)?.timestamp ?? header.timestamp,
    });
  } catch (error) {
    await cleanupForkDirectory(cwd, options);

    throw error;
  }

  return { hostId: currentHost(), sessionId, sessionPath, cwd };
}

async function cleanupForkDirectory(cwd: string, options: ForkOptions) {
  if (options.cwd !== undefined) await rmdir(cwd).catch(error => console.error(`Could not remove the folder of a failed fork, ${cwd}: ${error instanceof Error ? error.message : String(error)}`));
}

async function forkDirectory(cwd: string, options: ForkOptions) {

  if (options.cwd === undefined) return realpath(cwd);
  const destination = resolve(cwd, options.cwd);
  const path = join(await realpath(dirname(destination)), basename(destination));

  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (Check(fileErrorSchema, error) && error.code === "EEXIST") throw new Error(`Fork destination already exists: ${path}`);
    throw error;
  }

  return path;
}

function responseBoundary(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, index: number) {
  const entry = branch[index];

  if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Select an assistant response to branch from");
  const pending = new Set(entry.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []));
  let end = index;

  while (pending.size && end + 1 < branch.length) {
    const next = branch[++end];

    if (next.type !== "message") continue;

    if (next.message.role !== "toolResult") break;
    pending.delete(next.message.toolCallId);
  }

  if (pending.size) throw new Error("The selected response still has unfinished tool calls. Wait for those tools to finish before branching.");

  return end;
}

function positionedHistory(ctx: ExtensionContext, entryId: string | undefined, position: "before" | "at") {
  if (!entryId) throw new Error("Select an entry to branch from");
  const entry = ctx.sessionManager.getEntry(entryId);

  if (!entry) throw new Error("The selected entry is no longer in this conversation");

  if (position === "at") return ctx.sessionManager.getBranch(entry.id);

  if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Select a user message to branch before");

  return entry.parentId ? ctx.sessionManager.getBranch(entry.parentId) : [];
}

function forkHistory(ctx: ExtensionContext, entryId?: string) {
  const branch = ctx.sessionManager.getBranch();
  const complete = (entry: typeof branch[number]) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "toolUse" && !entry.message.content.some((part) => part.type === "toolCall");
  const entry = entryId ? branch.find((entry) => entry.id === entryId) : [...branch].reverse().find(complete);

  if (entryId && !entry) throw new Error("The selected response is no longer on the current branch. Reload the conversation and select it again.");

  if (!entry) return [];
  const end = entry.type === "compaction" ? branch.indexOf(entry) : responseBoundary(branch, branch.indexOf(entry));

  return branch.slice(0, end + 1);
}

function assertForkable(ctx: ExtensionContext) {
  if (!canFork(ctx.sessionManager.getEntries())) throw new Error("Only main chats can be forked");
}
