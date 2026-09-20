import type { ChatMessage, VoicePromptContext } from "../types";
import type { PiEntry } from "./messages";

export const VOICE_MESSAGE = "piop-voice";
export interface SpokenMessage { id: string; role: "user" | "assistant"; text: string; startMs: number; endMs: number; completed?: boolean; voiceContext?: VoicePromptContext }
export function spokenMessage(turn: SpokenMessage): ChatMessage {
  return { id: `voice:${turn.id}`, role: turn.role, content: turn.text, timestamp: turn.startMs, completedAt: turn.completed ? turn.endMs : undefined, streaming: !turn.completed, customType: VOICE_MESSAGE, voiceContext: turn.voiceContext };
}
export function voiceEntry(entry: PiEntry): ChatMessage | undefined {
  if (entry.type !== "custom" || entry.customType !== VOICE_MESSAGE) return;
  const turn = entry.data as SpokenMessage | undefined;
  if (!turn || typeof turn.id !== "string" || typeof turn.text !== "string" || !["user", "assistant"].includes(turn.role) || !Number.isFinite(turn.startMs)) return;
  return { ...spokenMessage(turn), entryId: entry.id, streaming: false };
}
export function mergeSpokenMessages(messages: ChatMessage[], spoken: ChatMessage[]) {
  if (!spoken.length) return messages;
  const merged = new Map(messages.map((message) => [message.id, message]));
  for (const message of spoken) {
    const previous = merged.get(message.id);
    merged.set(message.id, { ...previous, ...message });
  }
  return [...merged.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
export function voicePrompt(id: string, text: string) { return `[Voice request ${id}; answer concisely]\n${text}`; }
export function parseVoicePrompt(message: Record<string, unknown>) {
  if (message.role !== "user") return;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
  const match = text.match(/^\[Voice request ([a-f0-9-]{36}); answer concisely\]\n([\s\S]*)$/);
  if (match) return { id: `voice:${match[1]}`, content: match[2], customType: VOICE_MESSAGE };
}
