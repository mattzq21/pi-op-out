import { Type } from "typebox";
import { Parse } from "typebox/value";
import { request } from "./client.ts";

const locationSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String(), cwd: Type.String(), archived: Type.Boolean(), revision: Type.String() });

export async function locateConversation(sessionId: string, hostId: string, signal?: AbortSignal) {
  const location = Parse(locationSchema, await request("/orchestration", { action: "locate", sessionId, hostId }, signal, 30_000));

  if (location.sessionId !== sessionId) throw new Error("Conversation lookup returned another identity");

  return location;
}

export async function activeConversation(sessionId: string, hostId: string, signal?: AbortSignal) {
  const location = await locateConversation(sessionId, hostId, signal);

  if (location.archived) throw new Error("This child conversation is archived. Open its saved history or restore it before sending another task");

  return location;
}
