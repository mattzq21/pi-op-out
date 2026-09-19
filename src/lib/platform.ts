import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { Browser } from "@capacitor/browser";
import { mobileVoice } from "./mobileVoice";
import { remoteClient } from "./remoteClient";
export type { UnlistenFn };
export const isMobile = import.meta.env.MODE === "mobile";
const conversationClientId = (() => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;
  const fresh = `${isMobile ? "mobile" : "desktop"}:${id}`;
  const key = `piop-conversation-client:${isMobile ? "mobile" : "desktop"}`;
  try { const saved = localStorage.getItem(key); if (saved) return saved; localStorage.setItem(key, fresh); } catch { /* Keep a stable identity for this client lifetime. */ }
  return fresh;
})();
export const listen = <T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> => isMobile ? remoteClient.listen(event, handler) : nativeListen(event, handler);
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  args = { ...args, clientId: conversationClientId };
  if (!isMobile) return nativeInvoke<T>(command, args);
  if (command === "open_external_url") {
    const url = String(args?.url);
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only HTTP and HTTPS links can be opened."));
    return Browser.open({ url }).then(() => undefined as T);
  }
  if (command.startsWith("voice_")) return mobileVoice(command, args) as Promise<T>;
  return remoteClient.invoke<T>(command, args);
}
