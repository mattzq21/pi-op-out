export const keybindDefinitions = [
  { action: "newConversation", label: "New conversation", description: "Start a fresh conversation", defaultShortcut: "Mod+N" },
  { action: "toggleConversations", label: "Toggle conversations", description: "Show or hide the conversation panel", defaultShortcut: "Mod+B" },
  { action: "toggleTerminal", label: "Toggle terminal", description: "Open the terminal or return to chat", defaultShortcut: "Mod+J" },
  { action: "focusComposer", label: "Focus composer", description: "Move focus to the message composer", defaultShortcut: "Mod+L" },
  { action: "openSettings", label: "Open settings", description: "Open application settings", defaultShortcut: "Mod+," }
] as const;

export type KeybindAction = typeof keybindDefinitions[number]["action"];
export type Keybindings = Record<KeybindAction, string>;

export const defaultKeybindings = Object.fromEntries(keybindDefinitions.map((item) => [item.action, item.defaultShortcut])) as Keybindings;

const keyName = (key: string) => key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;

export function shortcutFromEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(keyName(event.key));
  return parts.join("+");
}

export function matchesShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, shortcut: string) {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const expected = {
    mod: parts.some((part) => part.toLowerCase() === "mod"),
    alt: parts.some((part) => part.toLowerCase() === "alt"),
    shift: parts.some((part) => part.toLowerCase() === "shift")
  };
  const key = parts.find((part) => !["mod", "alt", "shift"].includes(part.toLowerCase()));
  if (!key) return false;
  return expected.mod === (event.metaKey || event.ctrlKey)
    && expected.alt === event.altKey
    && expected.shift === event.shiftKey
    && key.toLowerCase() === keyName(event.key).toLowerCase();
}
