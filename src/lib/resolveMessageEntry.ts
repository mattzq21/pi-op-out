import { z } from "zod";
import type { ChatMessage } from "../types";
import { ConversationChangedError } from "./conversationChanged";
import { textOf } from "./content";
import { branchMessages } from "./messages";
import type { NativeTransport } from "./nativeTransport";
import { entrySchema } from "./responseSchemas";

export async function resolveMessageEntry(owner: NativeTransport, message: ChatMessage): Promise<string> {
  if (message.entryId) return message.entryId;
  const path = owner.currentSessionPath();
  const history = await owner.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.string().nullable() }));

  if (owner.currentSessionPath() !== path) throw new ConversationChangedError();
  const saved = branchMessages(history.entries, history.leafId).find(candidate => candidate.role === message.role && candidate.timestamp === message.timestamp && textOf(candidate.content) === textOf(message.content));

  if (!saved?.entryId) throw new Error("Could not find the response in the saved conversation");

  return saved.entryId;
}
