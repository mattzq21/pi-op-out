import type { ChatMessage } from "../types";
import { textOf } from "./content";

export function sameUserContent(submitted: ChatMessage, message: ChatMessage): boolean {
  if (submitted.role !== "user" || message.role !== "user" || textOf(submitted.content) !== textOf(message.content)) return false;
  const images = (content: ChatMessage["content"]) => Array.isArray(content) ? content.flatMap(part => part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : []) : [];

  return JSON.stringify(images(submitted.content)) === JSON.stringify(images(message.content));
}

export const matchesSubmittedMessage = (submitted: ChatMessage, message: ChatMessage) => Boolean(submitted.submissionId) && message.role === "user" && (submitted.submissionId === message.piopSubmissionId || Boolean(submitted.piopQueueId && submitted.piopQueueId === message.piopQueueId));

export function reconcilePendingMessages(messages: ChatMessage[], pending: { id: string; goalSubmissionId?: string }[] | undefined): ChatMessage[] {
  if (!pending) return messages;
  const queued = new Map(pending.map(item => [item.id, item]));
  const submissions = new Map(pending.filter(item => item.goalSubmissionId).map(item => [item.goalSubmissionId, item.id]));
  const next = messages.flatMap(message => {
    if (!message.submissionId) return [message];
    const queueId = submissions.get(message.submissionId) ?? message.piopQueueId;

    if (queueId && !queued.has(queueId)) return [];

    return [queueId && queueId !== message.piopQueueId ? { ...message, piopQueueId: queueId } : message];
  });

  return next.length === messages.length && next.every((message, index) => message === messages[index]) ? messages : next;
}

function reuseAssistantContent(previous: ChatMessage["content"], incoming: ChatMessage["content"]): ChatMessage["content"] {
  if (!Array.isArray(previous) || !Array.isArray(incoming)) return incoming;
  const content = incoming.map((part, position) => JSON.stringify(part) === JSON.stringify(previous[position]) ? previous[position] : part);

  return content.length === previous.length && content.every((part, position) => part === previous[position]) ? previous : content;
}

// Places a new live message after the delivered messages and before the submitted ones that wait.
export function insertLiveMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const delivered = messages.filter(item => !item.submissionId);
  const pending = messages.filter(item => item.submissionId && item.id !== message.id);

  return [...delivered, message, ...pending];
}

// The next form of a live message that is already shown, or undefined when it does not change.
export function mergeLiveMessage(previous: ChatMessage, message: ChatMessage): ChatMessage | undefined {
  const next = { ...message, entryId: message.entryId ?? previous.entryId, toolInput: message.toolInput ?? previous.toolInput, details: message.details ?? previous.details, promptContext: previous.promptContext };

  if (message.role === "assistant") next.content = reuseAssistantContent(previous.content, message.content);

  if (message.role === "user" && JSON.stringify(previous) === JSON.stringify(next)) return undefined;

  return next;
}

export function reconcileMessages(previous: ChatMessage[], incoming: ChatMessage[], pending?: { id: string; goalSubmissionId?: string }[]): ChatMessage[] {
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

  messages.push(...reconcilePendingMessages(submitted, pending));

  return messages.length === previous.length && messages.every((message, index) => message === previous[index]) ? previous : messages;
}
