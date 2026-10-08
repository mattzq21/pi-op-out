import type { ChatMessage } from "../types";

export function reconcileMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const saved = new Map(previous.map(message => [message.entryId ?? message.id, message]));
  const liveUsers = previous.filter(message => message.role === "user" && !message.entryId && message.timestamp !== undefined);

  const messages = incoming.map(message => {
    const old = saved.get(message.entryId ?? message.id);

    if (old) {
      const next = { ...message, id: old.id };

      return message.role !== "tool" && JSON.stringify(old) === JSON.stringify(next) ? old : next;
    }

    if (message.role !== "user") return message;
    const content = JSON.stringify(message.content);
    const liveIndex = liveUsers.findIndex(candidate => candidate.timestamp === message.timestamp && JSON.stringify(candidate.content) === content);

    if (liveIndex === -1) return message;
    const [live] = liveUsers.splice(liveIndex, 1);

    return { ...message, id: live.id };
  });

  return messages.length === previous.length && messages.every((message, index) => message === previous[index]) ? previous : messages;
}
