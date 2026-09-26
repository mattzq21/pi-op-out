import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Browser } from "@capacitor/browser";
import { registerPlugin } from "@capacitor/core";
import { remoteClient } from "./remoteClient";
export type { UnlistenFn };
export const isMobile = import.meta.env.MODE === "mobile";
const clientPreferences = registerPlugin<{ load(): Promise<{ settings: unknown }>; save(options: { settings: unknown }): Promise<void> }>("ClientPreferences");
const conversationClientId = (() => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;
  const fresh = `${isMobile ? "mobile" : "desktop"}:${id}`;
  const key = `piop-conversation-client:${isMobile ? "mobile" : "desktop"}`;
  try { const saved = localStorage.getItem(key); if (saved) return saved; localStorage.setItem(key, fresh); } catch { }
  return fresh;
})();
export const listen = <T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> => isMobile ? remoteClient.listen(event, handler) : nativeListen(event, handler, { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } });
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  args = { ...args, clientId: conversationClientId };
  if (!isMobile) {
    const local = ["load_client_settings", "save_client_settings", "new_window", "open_external_url", "open_project_directory", "read_dropped_file"];
    return local.includes(command) ? nativeInvoke<T>(command, args) : nativeInvoke<T>("daemon_invoke", { command, args });
  }
  if (command === "load_client_settings") return clientPreferences.load().then(result => result.settings as T);
  if (command === "save_client_settings") return clientPreferences.save({ settings: args.settings }).then(() => undefined as T);
  if (command === "open_external_url") {
    const url = String(args?.url);
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only HTTP and HTTPS links can be opened."));
    return Browser.open({ url }).then(() => undefined as T);
  }
  return remoteClient.invoke<T>(command, args);
}
