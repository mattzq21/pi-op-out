function isEditableField(field: Element | null) {
  if (!(field instanceof HTMLElement) || field.closest(".xterm, .cm-editor")) return false;

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

export function installTextEditingShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const command = historyCommand(event);

    if (!command) return;

    if (!isEditableField(document.activeElement)) return;

    if (document.activeElement?.closest("[data-custom-history]")) return;

    event.preventDefault();
    event.stopPropagation();
    document.execCommand(command);
  };

  document.addEventListener("keydown", handleKeyDown, true);

  return () => document.removeEventListener("keydown", handleKeyDown, true);
}
