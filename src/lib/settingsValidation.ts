import type { AppSettings, McpServer, PromptDictionary, RemoteHost } from "../types";

const shortcutParts = (shortcut: string) => shortcut.split("+").map((part) => part.trim()).filter(Boolean);

export function isUnsafeCharacterShortcut(shortcut: string) {
  const parts = shortcutParts(shortcut); const key = parts.find((part) => !["ctrl", "meta", "alt", "shift", "mod"].includes(part.toLocaleLowerCase()));
  return Boolean(key && [...key].length === 1 && !parts.some((part) => ["ctrl", "meta", "alt", "mod"].includes(part.toLocaleLowerCase())));
}

function canonicalShortcut(shortcut: string) {
  const parts = shortcutParts(shortcut); const lowered = parts.map((part) => part.toLocaleLowerCase());
  const modifiers = ["ctrl", "meta", "alt", "shift", "mod"].filter((modifier) => lowered.includes(modifier));
  const key = lowered.find((part) => !["ctrl", "meta", "alt", "shift", "mod"].includes(part));
  return key ? [...modifiers, key].join("+") : "";
}

export function keybindingValidationError(keybindings: AppSettings["keybindings"]) {
  const shortcuts = new Map<string, string>();
  for (const [action, shortcut] of Object.entries(keybindings)) {
    if (!shortcut.trim()) continue;
    if (isUnsafeCharacterShortcut(shortcut)) return `“${shortcut}” needs Ctrl, Alt, or Meta`;
    const canonical = canonicalShortcut(shortcut); const owner = shortcuts.get(canonical);
    if (owner) return `“${shortcut}” is assigned to both ${owner} and ${action}`;
    shortcuts.set(canonical, action);
  }
  return undefined;
}

function mcpValidationError(servers: McpServer[]) {
  const ids = new Set<string>();
  for (const server of servers) {
    if (!server.id.trim() || ids.has(server.id)) return "Every MCP server needs a unique id";
    ids.add(server.id);
    if (!server.name.trim()) return "Every MCP server needs a name";
    if ((server.transport ?? "stdio") === "stdio") {
      if (!server.command.trim()) return `${server.name}: command can't be empty`;
      continue;
    }
    let url: URL;
    try { url = new URL(server.url?.trim() ?? ""); } catch { return `${server.name}: enter a valid HTTP URL`; }
    if (!['http:', 'https:'].includes(url.protocol)) return `${server.name}: URL must use HTTP or HTTPS`;
    if (server.headers?.trim()) {
      let headers: unknown;
      try { headers = JSON.parse(server.headers); } catch { return `${server.name}: headers must be valid JSON`; }
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) return `${server.name}: headers must be a JSON object containing string values`;
    }
  }
  return undefined;
}

export function dictionaryValidationError(dictionaries: PromptDictionary[], activeIds: string[]) {
  const keys = new Set<string>();
  for (const dictionary of dictionaries) {
    if (!activeIds.includes(dictionary.id)) continue;
    for (const entry of dictionary.entries) {
      const key = entry.word.trim().toLocaleLowerCase(); if (!key) continue;
      if (keys.has(key)) return `“${entry.word.trim()}” appears more than once in active dictionaries`;
      keys.add(key);
    }
  }
  return undefined;
}

function machineValidationError(hosts: RemoteHost[]) {
  const names = new Set(["local"]); const ids = new Set<string>();
  for (const host of hosts) {
    if (!host.id.trim() || ids.has(host.id)) return "Every machine needs a unique id";
    ids.add(host.id);
    const name = host.name.trim().toLocaleLowerCase();
    if (!name) return "Every machine needs a name";
    if (names.has(name)) return `Machine name “${host.name.trim()}” is already in use`;
    names.add(name);
  }
  return undefined;
}

export function settingsValidationError(settings: AppSettings) {
  return keybindingValidationError(settings.keybindings)
    ?? mcpValidationError(settings.mcpServers)
    ?? dictionaryValidationError(settings.dictionaries, settings.activeDictionaryIds)
    ?? machineValidationError(settings.hosts);
}
