import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Browser } from "@capacitor/browser";
import { registerPlugin } from "@capacitor/core";
import { remoteClient } from "./remoteClient";
import { z, type JSONType } from "zod";
import { jsonResultSchema, nativeArgumentsSchema, type NativeArguments } from "./transportSchemas";
import { invokeWithBackpressure } from "./backpressure";

export type { UnlistenFn };

export const isMobile = import.meta.env.MODE === "mobile";

export function htmlPreviewSize() {
  const width = typeof window === "undefined" ? undefined : window.screen?.width;

  return typeof width === "number" && Number.isFinite(width) && width >= 2560 ? 750 : 600;
}

const clientPreferences = registerPlugin<{ load(): Promise<{ settings: unknown }>; save(options: { settings: unknown }): Promise<void> }>("ClientPreferences");

const conversationClientId = (() => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;
  const fresh = `${isMobile ? "mobile" : "desktop"}:${id}`;
  const key = `piop-conversation-client:${isMobile ? "mobile" : "desktop"}`;

  try { const saved = localStorage.getItem(key);

  if (saved) return saved; localStorage.setItem(key, fresh); } catch { }

  return fresh;
})();

export const listen = <S extends z.ZodType>(event: string, handler: EventCallback<z.output<S>>, schema: S): Promise<UnlistenFn> => isMobile ? remoteClient.listen(event, handler, schema) : nativeListen(event, value => handler({ ...value, payload: schema.parse(value.payload) }), { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } });

export function invoke<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
export function invoke(command: string, args?: NativeArguments): Promise<JSONType | undefined>;
export async function invoke(command: string, args?: NativeArguments, schema: z.ZodType = jsonResultSchema) {
  args = nativeArgumentsSchema.parse({ ...args, clientId: conversationClientId });

  if (!isMobile) {
    const local = ["load_client_settings", "save_client_settings", "new_window", "open_external_url", "open_project_directory", "open_rollout_file", "read_dropped_file"];

    const response = await (local.includes(command) ? nativeInvoke(command, args) : invokeWithBackpressure(() => nativeInvoke("daemon_invoke", { command, args })));

    return schema.parse(response);
  }

  if (command === "load_client_settings") return clientPreferences.load().then(result => schema.parse(result.settings));

  if (command === "save_client_settings") return clientPreferences.save({ settings: args.settings }).then(() => schema.parse(undefined));

  if (command === "open_external_url") {
    const url = String(args?.url);

    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only HTTP and HTTPS links can be opened."));

    return Browser.open({ url }).then(() => schema.parse(undefined));
  }

  return remoteClient.invoke(command, args, schema);
}
