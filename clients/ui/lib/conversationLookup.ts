import { z } from "zod";
import { nativeCall } from "./nativeCall";
import { sessionSnapshotSchema } from "./responseSchemas";

/** auxiliary: for an archived chat, whether it belongs to a root chat. Such a chat is only restored with its root. */
const locationSchema = z.object({ sessionId: z.string(), sessionPath: z.string(), cwd: z.string(), archived: z.boolean(), revision: z.string(), auxiliary: z.boolean().optional() });

export async function locateConversation(sessionId: string, hostId: string) {
  const location = await nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "locate", sessionId, hostId: "local" } }, locationSchema);

  if (location.sessionId !== sessionId) throw new Error("Conversation lookup returned another identity");

  return location;
}

/** Renames a saved conversation on its host and returns the name it got. */
export async function renameConversation(sessionId: string, hostId: string, name: string) {
  return (await nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "rename", sessionId, hostId: "local", name } }, z.object({ name: z.string() }))).name;
}

/** The recent history of a saved conversation, from its host without waiting for its Pi to start. */
export function previewConversation(sessionId: string, hostId: string) {
  return nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "preview", sessionId, hostId: "local" } }, sessionSnapshotSchema);
}
