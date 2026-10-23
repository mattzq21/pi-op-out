import { z } from "zod";
import { nativeCall } from "./nativeCall";

const locationSchema = z.object({ sessionId: z.string(), sessionPath: z.string(), cwd: z.string(), archived: z.boolean(), revision: z.string() });

export async function locateConversation(sessionId: string, hostId: string) {
  const location = await nativeCall("broker_request", { hostId, path: "/orchestration", body: { action: "locate", sessionId, hostId: "local" } }, locationSchema);

  if (location.sessionId !== sessionId) throw new Error("Conversation lookup returned another identity");

  return location;
}
