import { createSignal } from "solid-js";
import type { ChatMessage } from "../types";

const [revision, setRevision] = createSignal(0);

const stopped = new Map<string, string>();

const messageKey = (message: ChatMessage) => String(message.timestamp ?? message.entryId ?? message.id);

const storageKey = (session: string) => `piop-stopped-prompt:${session}`;

export function markStoppedPrompt(session: string, messages: ChatMessage[]) {
  const user = [...messages].reverse().find(message => message.role === "user");

  if (!session || !user) return;
  const key = messageKey(user);
  stopped.set(session, key);

  try { sessionStorage.setItem(storageKey(session), key); } catch { }

  setRevision(value => value + 1);
}

export function wasPromptStopped(session: string, user: ChatMessage) {
  revision();
  let key = stopped.get(session);

  if (!key) {
    try { key = sessionStorage.getItem(storageKey(session)) ?? undefined; } catch { }
  }

  return key === messageKey(user);
}
