function isEditableField(field: Element | null) {
  if (!(field instanceof HTMLElement) || field.closest(".xterm")) return false;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    if (field.disabled || field.readOnly) return false;
    return !(field instanceof HTMLInputElement) || ["text", "search", "email", "url", "tel", "password", "number"].includes(field.type);
  }
  return field.isContentEditable;
}

function historyCommand(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" && !event.shiftKey ? "redo" : undefined;
}

/** Webviews do not consistently bind the platform's undo/redo shortcuts. */
export function installTextEditingShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const command = historyCommand(event);
    if (!command) return;

    if (!isEditableField(document.activeElement)) return;

    // Use the browser's history so typing, paste, selection and IME edits retain
    // their native undo boundaries and emit input events for controlled fields.
    // Consume even an empty history before configurable app shortcuts see it.
    event.preventDefault();
    event.stopPropagation();
    document.execCommand(command);
  };
  document.addEventListener("keydown", handleKeyDown, true);
  return () => document.removeEventListener("keydown", handleKeyDown, true);
}
