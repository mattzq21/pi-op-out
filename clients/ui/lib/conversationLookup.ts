import { z } from "zod";
import { nativeCall } from "./nativeCall";
import { sessionSnapshotSchema } from "./responseSchemas";

const locationSchema = z.object({ sessionId: z.string(), sessionPath: z.string(), cwd: z.string(), archived: z.boolean(), revision: z.string(), auxiliary: z.boolean().optional() });

export async function locateConversation(sessionId: string, hostId: string) {
  const location = await nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "locate", sessionId, hostId: "local" } }, locationSchema);

  if (location.sessionId !== sessionId) throw new Error("Conversation lookup returned another identity");

  return location;
}

export async function renameConversation(sessionId: string, hostId: string, name: string) {
  return (await nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "rename", sessionId, hostId: "local", name } }, z.object({ name: z.string() }))).name;
}

export function previewConversation(sessionId: string, hostId: string) {
  return nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "preview", sessionId, hostId: "local" } }, sessionSnapshotSchema);
}
