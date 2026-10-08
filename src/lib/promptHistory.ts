import { z } from "zod";
import { isMobile } from "./platform";
import type { KeyboardEvent } from "./solid";

const storageKey = "piop.prompt-history";

const historySchema = z.array(z.string());

let cached: string[] = [];

function readHistory(fallback: string[]): string[] {
  try { cached = historySchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "[]")); } catch { }

  return (cached.length ? cached : fallback).filter(prompt => prompt.trim()).slice(-100);
}

export function rememberPrompt(prompt: string, fallback: string[] = []) {
  if (!prompt.trim()) return;
  const previous = readHistory(fallback);

  cached = previous.at(-1) === prompt ? previous : [...previous.slice(-99), prompt];

  try { localStorage.setItem(storageKey, JSON.stringify(cached)); } catch { }
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
