export const keybindDefinitions = [
  { action: "newConversation", label: "New conversation", description: "Start a fresh conversation", defaultShortcut: "Ctrl+N" },
  { action: "toggleConversations", label: "Toggle conversations", description: "Show or hide the conversation panel", defaultShortcut: "Ctrl+B" },
  { action: "toggleTerminal", label: "Toggle terminal", description: "Show or hide the session terminal panel", defaultShortcut: "Ctrl+J" },
  { action: "toggleDebugMode", label: "Toggle debug mode", description: "Show or hide response context details", defaultShortcut: "Ctrl+D" },
  { action: "focusComposer", label: "Focus composer", description: "Move focus to the message composer", defaultShortcut: "Ctrl+E" },
  { action: "openSettings", label: "Open settings", description: "Open application settings", defaultShortcut: "Ctrl+," }
] as const;

export type KeybindAction = typeof keybindDefinitions[number]["action"];
export type Keybindings = Record<KeybindAction, string>;

export const defaultKeybindings = Object.fromEntries(keybindDefinitions.map((item) => [item.action, item.defaultShortcut])) as Keybindings;

const keyName = (key: string) => key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;

export const MODIFIERS = new Set(["mod", "ctrl", "meta", "alt", "shift"]);

export function parseShortcut(shortcut: string) {
  const parts = splitShortcut(shortcut).map((part) => part.toLowerCase());
  if (!parts.length) return undefined;
  const has = (name: string) => parts.includes(name);
  const keys = parts.filter((part) => !MODIFIERS.has(part));
  if (keys.length !== 1) return undefined;
  return { mod: has("mod"), ctrl: has("ctrl"), meta: has("meta"), alt: has("alt"), shift: has("shift"), key: keys[0] };
}

export function shortcutError(shortcut: string) {
  if (!shortcut.trim()) return undefined;
  const parsed = parseShortcut(shortcut);
  if (!parsed || parsed.key === "control") return `Shortcut “${shortcut}” needs exactly one non-modifier key`;
  if (!parsed.mod && !parsed.ctrl && !parsed.meta && !parsed.alt) return `Shortcut “${shortcut}” needs Ctrl, Alt, or Meta`;
  if ((parsed.key === "f" || parsed.key === "g") && !parsed.alt && !parsed.shift && (parsed.mod || parsed.ctrl || parsed.meta)) return `Shortcut “${shortcut}” is reserved for search`;
  return undefined;
}

export function keybindingsError(keybindings: Keybindings) {
  const shortcuts = Object.values(keybindings).filter((shortcut) => shortcut.trim());
  for (const [index, shortcut] of shortcuts.entries()) {
    const error = shortcutError(shortcut);
    if (error) return error;
    if (shortcuts.slice(0, index).some((other) => shortcutsConflict(shortcut, other))) return `Shortcut “${shortcut}” is assigned more than once`;
  }
  return undefined;
}

function primaryModifiers(shortcut: NonNullable<ReturnType<typeof parseShortcut>>) {
  const primary = new Set<string>();
  if (shortcut.mod) { primary.add("ctrl"); primary.add("meta"); }
  if (shortcut.ctrl) primary.add("ctrl");
  if (shortcut.meta) primary.add("meta");
  return primary;
}

export function shortcutsConflict(left: string, right: string) {
  const a = parseShortcut(left);
  const b = parseShortcut(right);
  if (!a || !b) return false;
  if (a.key.toLowerCase() !== b.key.toLowerCase()) return false;
  if (a.alt !== b.alt || a.shift !== b.shift) return false;
  const aPrimary = primaryModifiers(a);
  const bPrimary = primaryModifiers(b);
  if (aPrimary.size === 0 && bPrimary.size === 0) return true;
  for (const key of aPrimary) if (bPrimary.has(key)) return true;
  return false;
}

function splitShortcut(shortcut: string) {
  // Keep a literal "+" key: "Ctrl++" -> ["Ctrl", "+"].
  // A single trailing "+" denotes the "+" key itself: "Ctrl++" -> ["Ctrl", "+"].
  const raw = shortcut.split("+");
  let plusKey = false;
  if (raw.length > 1 && raw[raw.length - 1].trim() === "") { plusKey = true; raw.pop(); }
  const parts = raw.map((part) => part.trim()).filter(Boolean);
  if (plusKey) parts.push("+");
  return parts;
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
const hasEventModifier = (event: ShortcutEvent) => event.ctrlKey || event.metaKey || event.altKey;

export function shortcutFromEvent(event: ShortcutEvent) {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  if (["Tab", "Escape"].includes(event.key) && !hasEventModifier(event)) return null;
  if ([...event.key].length === 1 && !hasEventModifier(event)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(keyName(event.key));
  return parts.join("+");
}

function matchesModifiers(event: ShortcutEvent, expected: NonNullable<ReturnType<typeof parseShortcut>>) {
  if (!expected.mod && !expected.ctrl && !expected.meta && !expected.alt) return false;
  const primaryMatches = expected.mod ? event.metaKey || event.ctrlKey : expected.ctrl === event.ctrlKey && expected.meta === event.metaKey;
  return primaryMatches && expected.alt === event.altKey && expected.shift === event.shiftKey;
}

export function matchesShortcut(event: ShortcutEvent, shortcut: string) {
  const parts = splitShortcut(shortcut);
  if (!parts.length) return false;
  const expected = {
    mod: parts.some((part) => part.toLowerCase() === "mod"),
    ctrl: parts.some((part) => part.toLowerCase() === "ctrl"),
    meta: parts.some((part) => part.toLowerCase() === "meta"),
    alt: parts.some((part) => part.toLowerCase() === "alt"),
    shift: parts.some((part) => part.toLowerCase() === "shift")
  };
  const keys = parts.filter((part) => !MODIFIERS.has(part.toLowerCase()));
  // Require exactly one non-modifier key; extra trailing tokens must not match loosely.
  if (keys.length !== 1) return false;
  const key = keys[0];
  // A bare modifier name in the key position (e.g. "Ctrl+Control") must not match a lone modifier tap.
  if (["control", "meta", "alt", "shift", "mod"].includes(key.toLowerCase())) return false;
  // Every shortcut needs a real modifier (Ctrl, Alt, Meta, or Mod): bare keys
  // such as "Space" must never match, so typing cannot trigger global actions.
  return matchesModifiers(event, { ...expected, key }) && key.toLowerCase() === keyName(event.key).toLowerCase();
}
