import { isMobile } from "./platform";
import type { KeyboardEvent } from "./solid";

type EditorEvent = KeyboardEvent<HTMLTextAreaElement>;

function pasteShortcut(event: EditorEvent) {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !event.altKey;
}

function submitShortcut(event: EditorEvent) {
  return event.key === "Enter" && !event.shiftKey && (!isMobile || event.ctrlKey);
}

export function createComposerEditorKey(options: {
  paste: () => void;
  ownershipRequired: () => boolean | undefined;
  palette: (event: EditorEvent) => boolean;
  history: (event: EditorEvent) => boolean;
  submit: (behavior: "steer" | "followUp") => Promise<void>;
}) {
  return (event: EditorEvent) => {
    if (pasteShortcut(event)) options.paste();

    if (options.ownershipRequired() || event.isComposing) return;

    if (options.palette(event) || options.history(event)) return;

    if (submitShortcut(event)) {
      event.preventDefault(); event.stopPropagation();
      void options.submit(event.ctrlKey ? "steer" : "followUp");
    }
  };
}
