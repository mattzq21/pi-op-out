import type { AppSettings } from './settings_types';

export function defaultKeybindings(): Record<string, string> {
  return {
    newConversation: 'Ctrl+N',
    toggleConversations: 'Ctrl+B',
    toggleTerminal: 'Ctrl+J',
    toggleDebugMode: 'Ctrl+D',
    focusComposer: 'Ctrl+E',
    openSettings: 'Ctrl+,',
  };
}

export function canonicalShortcut(shortcut: string): string | undefined {
  const raw = shortcut.split('+');
  let plusKey = false;
  if (raw.length > 1 && raw[raw.length - 1]!.trim() === '') { plusKey = true; raw.pop(); }
  const parts = raw.map(part => part.trim().toLowerCase()).filter(part => part !== '');
  if (plusKey) parts.push('+');
  if (!parts.length) return undefined;
  const modifiers = ['ctrl', 'meta', 'alt', 'shift', 'mod'];
  const keys = parts.filter(part => !modifiers.includes(part));
  if (keys.length !== 1) throw new Error(`Shortcut '${shortcut}' needs exactly one key`);
  const key = keys[0]!;
  if (['control', 'meta', 'alt', 'shift', 'mod'].includes(key)) throw new Error(`Shortcut '${shortcut}' needs a key`);
  if (!parts.some(part => ['ctrl', 'meta', 'alt', 'mod'].includes(part))) throw new Error(`Shortcut '${shortcut}' needs Ctrl, Alt, or Meta`);
  return [...modifiers.filter(modifier => parts.includes(modifier)), key].join('+');
}

export function migrateKeybindings(settings: AppSettings): void {
  const supported = defaultKeybindings();
  for (const action of Object.keys(settings.keybindings)) if (!(action in supported)) delete settings.keybindings[action];
  for (const [action, shortcut] of Object.entries(supported)) if (!(action in settings.keybindings)) settings.keybindings[action] = shortcut;
  if (settings.keybindings.focusComposer === 'Ctrl+L') settings.keybindings.focusComposer = 'Ctrl+E';
}

export function validateKeybindings(settings: AppSettings): void {
  const shortcuts = new Set<string>();
  for (const shortcut of Object.values(settings.keybindings)) {
    const canonical = canonicalShortcut(shortcut);
    if (canonical === undefined) continue;
    if (['ctrl+g', 'meta+g', 'mod+g'].includes(canonical)) throw new Error(`Shortcut '${shortcut}' is reserved for conversation search`);
    if (shortcuts.has(canonical)) throw new Error(`Shortcut '${shortcut}' is assigned more than once`);
    shortcuts.add(canonical);
  }
}
