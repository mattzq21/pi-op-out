import { z } from "zod";
import { invoke, isMobile, listen } from "./platform";
import { reportBackgroundError } from "./backgroundErrors";
import type { KeyboardEvent } from "./solid";

const storageKey = "piop.prompt-history";

const historySchema = z.array(z.string());

let cached: string[] = [];

let initialized = false;

let saving: Promise<void> | undefined;

let refreshPending = false;

let subscribed = false;

const pending: { id: string; prompt: string }[] = [];

function syncHistory() {
  if (isMobile) return;

  if (saving) { refreshPending = true;

  return; }

  refreshPending = false;
  const sent = [...pending];
  const legacy = readHistory([]);
  let succeeded = false;
  saving = invoke("sync_prompt_history", { entries: sent, legacy: legacy.slice(0, Math.max(0, legacy.length - sent.length)) }, historySchema).then(history => {
    pending.splice(0, sent.length);
    cached = [...history, ...pending.map(entry => entry.prompt)].slice(-100);
    succeeded = true;

    try { localStorage.removeItem(storageKey); } catch { }
  }).catch(error => { reportBackgroundError("Could not save prompt history", error); }).finally(() => {
    saving = undefined;

    if (succeeded && (pending.length || refreshPending)) syncHistory();
  });
}

function startHistorySync() {
  if (isMobile) return;

  if (!subscribed) {
    subscribed = true;
    window.addEventListener("focus", syncHistory);
    void listen("pi://prompt-history-changed", syncHistory, z.null()).then(() => syncHistory()).catch(error => {
      subscribed = false;
      window.removeEventListener("focus", syncHistory);
      reportBackgroundError("Could not watch prompt history", error);
    });
  }

  syncHistory();
}

function readHistory(fallback: string[]): string[] {
  if (!initialized) {
    initialized = true;

    try { cached = historySchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "[]")); } catch { }
  }

  return (cached.length ? cached : fallback).filter(prompt => prompt.trim()).slice(-100);
}

export function rememberPrompt(prompt: string, fallback: string[] = []) {
  if (!prompt.trim()) return;
  const previous = readHistory(fallback);

  cached = previous.at(-1) === prompt ? previous : [...previous.slice(-99), prompt];

  if (previous.at(-1) !== prompt) pending.push({ id: crypto.randomUUID(), prompt });
  syncHistory();
}

export function createPromptHistoryNavigation(fallback: () => string[]) {
  let position: number | undefined;
  let prompts: string[] = [];
  let draft = "";
  let recalled: string | undefined;

  const reset = () => { position = undefined; prompts = []; recalled = undefined; };

  const begin = (current: string, atBoundary: boolean) => {
    if (!atBoundary) return false;
    prompts = readHistory(fallback());

    if (!prompts.length) return false;
    draft = current;
    position = prompts.length;

    return true;
  };

  const move = (direction: "older" | "newer", current: string, atBoundary: boolean): string | undefined => {
    if (recalled !== current) reset();

    if (position === undefined) {
      if (direction === "newer" || !begin(current, atBoundary)) return;
    }

    const next = Math.max(0, Math.min(prompts.length, (position ?? prompts.length) + (direction === "older" ? -1 : 1)));

    if (next === prompts.length) { const restored = draft; reset();

    return restored; }

    position = next;
    recalled = prompts[next];

    return recalled;
  };

  return { move, reset };
}

function historyKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

  return event.key === "ArrowUp" || event.key === "ArrowDown";
}

export function createComposerPromptHistory(read: () => string, write: (value: string) => void, fallback: () => string[], onNavigate: (value: string) => void) {
  const navigation = createPromptHistoryNavigation(fallback);
  startHistorySync();

  const captureRemember = () => {
    const previous = fallback();

    return (prompt: string) => { if (!isMobile) rememberPrompt(prompt, previous); };
  };

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMobile || !historyKey(event)) return false;
    const editor = event.currentTarget;

    if (editor.selectionStart !== editor.selectionEnd) return false;
    const direction = event.key === "ArrowUp" ? "older" : "newer";
    const atBoundary = !read().slice(0, editor.selectionStart).includes("\n");
    const next = navigation.move(direction, read(), atBoundary);

    if (next === undefined) return false;
    event.preventDefault(); event.stopPropagation();
    write(next);
    onNavigate(next);
    queueMicrotask(() => { if (editor.isConnected) editor.setSelectionRange(next.length, next.length); });

    return true;
  };

  return { handleKey, reset: navigation.reset, captureRemember };
}
