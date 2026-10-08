import type { ChatMessage } from "../types";
import { textOf } from "./content";

export function sameUserContent(submitted: ChatMessage, message: ChatMessage): boolean {
  if (submitted.role !== "user" || message.role !== "user" || textOf(submitted.content) !== textOf(message.content)) return false;
  const images = (content: ChatMessage["content"]) => Array.isArray(content) ? content.flatMap(part => part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : []) : [];

  return JSON.stringify(images(submitted.content)) === JSON.stringify(images(message.content));
}

export const matchesSubmittedMessage = (submitted: ChatMessage, message: ChatMessage) => Boolean(submitted.submissionId) && sameUserContent(submitted, message);

function reuseAssistantContent(previous: ChatMessage["content"], incoming: ChatMessage["content"]): ChatMessage["content"] {
  if (!Array.isArray(previous) || !Array.isArray(incoming)) return incoming;
  const content = incoming.map((part, position) => JSON.stringify(part) === JSON.stringify(previous[position]) ? previous[position] : part);

  return content.length === previous.length && content.every((part, position) => part === previous[position]) ? previous : content;
}

export function upsertLiveMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex(item => item.id === message.id);

  if (index === -1) return [...messages, message];
  const previous = messages[index];
  const next = { ...message, entryId: message.entryId ?? previous.entryId, toolInput: message.toolInput ?? previous.toolInput, details: message.details ?? previous.details, fileChanges: previous.fileChanges, promptContext: previous.promptContext };

  if (message.role === "assistant") next.content = reuseAssistantContent(previous.content, message.content);

  if (message.role === "user" && JSON.stringify(previous) === JSON.stringify(next)) return messages;

  return messages.map((item, position) => position === index ? next : item);
}

export function reconcileMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const saved = new Map(previous.map(message => [message.entryId ?? message.id, message]));
  const liveUsers = previous.filter(message => message.role === "user" && !message.entryId && message.timestamp !== undefined);
  const submitted = previous.filter(message => message.submissionId);

  const messages = incoming.map(message => {
    const old = saved.get(message.entryId ?? message.id);

    if (old) {
      if (old.submissionId) submitted.splice(submitted.findIndex(candidate => candidate.id === old.id), 1);
      const next = { ...message, id: old.id };

      return message.role !== "tool" && JSON.stringify(old) === JSON.stringify(next) ? old : next;
    }

    if (message.role !== "user") return message;
    const content = JSON.stringify(message.content);
    const liveIndex = liveUsers.findIndex(candidate => candidate.timestamp === message.timestamp && JSON.stringify(candidate.content) === content);

    if (liveIndex !== -1) {
      const [live] = liveUsers.splice(liveIndex, 1);

      return { ...message, id: live.id };
    }

    const submittedIndex = submitted.findIndex(candidate => matchesSubmittedMessage(candidate, message));

    if (submittedIndex === -1) return message;
    const [pending] = submitted.splice(submittedIndex, 1);

    return { ...message, id: pending.id };
  });

  messages.push(...submitted);

  return messages.length === previous.length && messages.every((message, index) => message === previous[index]) ? previous : messages;
}
