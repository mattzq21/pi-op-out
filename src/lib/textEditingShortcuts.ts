/** Webviews do not consistently bind the platform's undo/redo shortcuts. */
export function installTextEditingShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const command = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" && !event.shiftKey ? "redo" : undefined;
    if (!command) return;

    const field = document.activeElement;
    if (!(field instanceof HTMLElement) || field.closest(".xterm")) return;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.disabled || field.readOnly) return;
      if (field instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "password", "number"].includes(field.type)) return;
    } else if (!field.isContentEditable) return;

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
