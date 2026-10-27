import { createContext } from "solid-js";
import { z } from "zod";
import type { ImageAttachment, SessionSummary } from "../types";

/** The title of the extension request that opens an auxiliary chat, such as a btw or review chat, in the side pane. */
export const OPEN_AUXILIARY_CHAT = "__pi_desktop_auxiliary__";

const openingSchema = z.object({
  kind: z.string().min(1), name: z.string().min(1), sessionId: z.string().min(1), sessionPath: z.string().min(1), cwd: z.string(), hostId: z.string().min(1), parentSessionId: z.string().min(1),
  task: z.string().optional(), images: z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() })).optional(),
});

/** Finds and opens auxiliary chats that are not archived, for transcript rows such as review links. */
export interface AuxiliaryChats { listed: (hostId: string, sessionId: string) => boolean; open: (hostId: string, sessionId: string) => void }

export const AuxiliaryChatsContext = createContext<AuxiliaryChats>();

/**
 * The keys of the working chats for the session list: each working chat, and the root chat of each working side chat,
 * such as a btw or review chat. Subagents do not mark their root chat.
 */
export function withWorkingSideChats(sessions: SessionSummary[], running: ReadonlySet<string>): ReadonlySet<string> {
  const key = (hostId: string | undefined, id: string) => `${hostId ?? "local"}:${id}`;
  const byKey = new Map(sessions.map(session => [key(session.hostId, session.id), session]));
  const result = new Set(running);

  for (const session of sessions) {
    if (!session.auxiliaryParentId || session.auxiliaryKind === "subagent" || !(session.isRunning || running.has(key(session.hostId, session.id)))) continue;
    let root = key(session.hostId, session.auxiliaryParentId);

    for (const seen = new Set([root]); byKey.get(root)?.auxiliaryParentId;) {
      root = key(session.hostId, byKey.get(root)!.auxiliaryParentId!);

      if (seen.has(root)) break;
      seen.add(root);
    }

    result.add(root);
  }

  return result;
}

/** Reads the request that opens an auxiliary chat. Throws when it is malformed. */
export function parseAuxiliaryOpening(placeholder?: string): { session: SessionSummary; task?: string; images?: ImageAttachment[] } {
  const parsed = openingSchema.safeParse((() => { try { return JSON.parse(placeholder || "{}"); } catch { return undefined; } })());

  if (!parsed.success) throw new Error("Invalid side chat request");
  const value = parsed.data;
  const session: SessionSummary = {
    id: value.sessionId, path: value.sessionPath, hostId: value.hostId, name: value.name, cwd: value.cwd, project: value.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace",
    preview: value.task ?? "", messageCount: 0, lastMessageAt: Date.now(), apiCost: 0, auxiliaryKind: value.kind, auxiliaryParentId: value.parentSessionId,
  };

  return { session, task: value.task, images: value.images };
}
