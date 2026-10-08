import { z } from "zod";
import { nativeCall } from "./nativeCall";
import { gitDiffSnapshotSchema, gitDiffSnapshotsSchema } from "./responseSchemas";
import type { GitDiffSnapshot, GitDiffSnapshots } from "../types";

const fragmentSchema = z.object({ messageId: z.string(), content: z.string(), complete: z.boolean() });

const pageSchema = z.object({ snapshots: gitDiffSnapshotsSchema, next: z.string().nullable(), fragment: fragmentSchema.optional() });

const partResultSchema = z.object({ complete: z.boolean() });

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024 * 6 + 64 * 1024;

const PART_CHARACTERS = 512 * 1024;

type Fragment = { messageId: string; chunks: string[]; bytes: number };

function collectFragment(previous: Fragment | undefined, fragment: z.infer<typeof fragmentSchema>, snapshots: Map<string, GitDiffSnapshot>) {
  if (previous && previous.messageId !== fragment.messageId) throw new Error("Saved project changes switched messages before completing a fragment");
  const current = previous ?? { messageId: fragment.messageId, chunks: [], bytes: 0 };
  current.bytes += new TextEncoder().encode(fragment.content).byteLength;

  if (current.bytes > MAX_SNAPSHOT_BYTES) throw new Error("Permanent diff limit: saved project changes exceed the individual snapshot limit; storage is preserved");
  current.chunks.push(fragment.content);

  if (!fragment.complete) return current;
  snapshots.set(fragment.messageId, gitDiffSnapshotSchema.parse(JSON.parse(current.chunks.join(""))));
}

export async function readGitDiffs(sessionPath: string, hostId: string, ephemeralSessionId?: string): Promise<GitDiffSnapshots> {
  const snapshots = new Map<string, GitDiffSnapshot>();
  const cursors = new Set<string>();
  let cursor = "";
  let fragment: Fragment | undefined;

  while (true) {
    if (cursors.has(cursor)) throw new Error("Saved project changes returned a repeated page; retry loading the history");
    cursors.add(cursor);
    const command = ephemeralSessionId ? "load_ephemeral_git_diff_page" : "load_git_diff_page";
    const page = await nativeCall(command, { sessionPath, hostId, sessionId: ephemeralSessionId, page: cursor }, pageSchema);

    for (const [id, snapshot] of Object.entries(page.snapshots)) snapshots.set(id, snapshot);

    if (page.fragment) fragment = collectFragment(fragment, page.fragment, snapshots);

    if (page.next === null) break;
    cursor = page.next;
  }

  if (fragment) throw new Error("Saved project changes ended with an incomplete snapshot; storage is preserved");

  return Object.fromEntries(snapshots);
}

function partEnd(serialized: string, start: number) {
  const end = Math.min(start + PART_CHARACTERS, serialized.length);
  const last = serialized.charCodeAt(end - 1);

  return end < serialized.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

async function snapshotDigest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function appendSnapshot(sessionPath: string, hostId: string, messageId: string, snapshot: GitDiffSnapshot) {
  const serialized = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(serialized);

  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("Permanent diff limit: copied project changes exceed the individual snapshot limit; source history is preserved");
  const digest = await snapshotDigest(bytes);
  let index = 0;

  for (let offset = 0; offset < serialized.length; index++) {
    const end = partEnd(serialized, offset);
    const final = end === serialized.length;
    const part = { messageId, transferId: digest, index, content: serialized.slice(offset, end), final, digest };
    const result = await nativeCall("append_git_diff_part", { sessionPath, hostId, part }, partResultSchema);

    if (final && !result.complete) throw new Error("Copied project changes were not committed; retained for retry");
    offset = end;
  }
}

export async function appendGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId: string) {
  for (const [messageId, snapshot] of Object.entries(snapshots)) await appendSnapshot(sessionPath, hostId, messageId, snapshot);
}
