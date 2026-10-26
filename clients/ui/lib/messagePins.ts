import { createContext } from "solid-js";
import { z } from "zod";
import type { ChatMessage } from "../types";

export const PIN_LIMIT = 4;

export const pinnedMessagesSchema = z.array(z.object({ entryId: z.string(), role: z.enum(["prompt", "response"]), text: z.string() }));

/** A message pinned to the top of the chat. An empty text is a prompt that has only attachments. */
export type MessagePin = z.infer<typeof pinnedMessagesSchema>[number];

/** pinned tells if a message is pinned. toggle pins or unpins a message, with the text that its pin shows. */
export interface MessagePins { pinned: (id: string) => boolean; toggle: (message: ChatMessage, text: string) => Promise<void> }

export const MessagePinContext = createContext<MessagePins>();

/** The ID that a pin uses for a message: its saved entry. */
export const pinId = (message: ChatMessage) => message.entryId ?? message.id;

/** The first line of a message as plain text, for its pin. Text files sent with a prompt are not part of it. */
export function pinText(value: string) {
  const text = value.replace(/<file name="[^"]*">\n[\s\S]*?\n<\/file>/g, "");
  const line = text.split("\n").find(part => part.trim())?.trim() ?? "";

  return line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/(^|[^\w*])[*_](\S(?:[^*_\n]*\S)?)[*_](?=[^\w*]|$)/g, "$1$2").trim();
}
