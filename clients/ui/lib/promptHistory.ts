import { isMobile } from "./platform";
import type { KeyboardEvent } from "./solid";

/**
 * Up and Down in an empty composer go through the prompts of this conversation, newest first. Navigation starts only
 * from an empty composer; Down past the newest prompt empties it again.
 */
export function createPromptHistoryNavigation(prompts: () => string[]) {
  let position: number | undefined;
  let list: string[] = [];
  let recalled: string | undefined;

  const reset = () => { position = undefined; list = []; recalled = undefined; };

  const move = (direction: "older" | "newer", current: string): string | undefined => {
    if (recalled !== current) reset();

    if (position === undefined) {
      if (direction === "newer" || current !== "") return;
      list = prompts().filter(prompt => prompt.trim());
      if (!list.length) return;
      position = list.length;
    }

    const next = Math.max(0, Math.min(list.length, position + (direction === "older" ? -1 : 1)));

    if (next === list.length) { reset(); return ""; }
    position = next;
    recalled = list[next];

    return recalled;
  };

  return { move, reset };
}

function historyKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

  return event.key === "ArrowUp" || event.key === "ArrowDown";
}

export function createComposerPromptHistory(read: () => string, write: (value: string) => void, prompts: () => string[], onNavigate: (value: string) => void) {
  const navigation = createPromptHistoryNavigation(prompts);

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMobile || !historyKey(event)) return false;
    const editor = event.currentTarget;

    if (editor.selectionStart !== editor.selectionEnd) return false;
    const next = navigation.move(event.key === "ArrowUp" ? "older" : "newer", read());

    if (next === undefined) return false;
    event.preventDefault(); event.stopPropagation();
    write(next);
    onNavigate(next);
    queueMicrotask(() => { if (editor.isConnected) editor.setSelectionRange(next.length, next.length); });

    return true;
  };

  return { handleKey, reset: navigation.reset };
}
