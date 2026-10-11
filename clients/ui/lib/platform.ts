import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Browser } from "@capacitor/browser";
import { registerPlugin } from "@capacitor/core";
import { remoteClient } from "./remoteClient";
import { z, type JSONType } from "zod";
import { jsonResultSchema, nativeArgumentsSchema, type NativeArguments } from "./transportSchemas";
import { invokeWithBackpressure } from "./backpressure";
import type { SettingsPublication } from "../types";
import { clientIdentity } from "./clientIdentity";
import { daemonError } from "./storageFailure";

export type { UnlistenFn };

export const isMobile = import.meta.env.MODE === "mobile";

export function htmlPreviewSize() {
  const width = typeof window === "undefined" ? undefined : window.screen?.width;

  return z.number().finite().min(2560).safeParse(width).success ? 750 : 600;
}

const clientPreferences = registerPlugin<{
  load(): Promise<{ settings: unknown; revision: string }>;
  save(options: { settings: unknown; baseline: unknown; initialize: boolean }): Promise<{ settings: unknown; revision: string; publication: SettingsPublication }>;
}>("ClientPreferences");

/** The on-device speech engine of the Android app. */
const dictationPlugin = registerPlugin<{
  addListener(event: string, listener: (payload: unknown) => void): Promise<{ remove(): Promise<void> }>;
}>("Dictation");

/** Dictation commands run on this device. On Android they map to the Dictation plugin methods. */
const dictationCommands: Record<string, string> = {
  dictation_configuration: "configuration", dictation_stream_start: "start", dictation_stream_feed: "feed", dictation_stream_finish: "finish", dictation_stream_cancel: "cancel",
  dictation_models: "models", dictation_model_save: "saveModel", dictation_model_cancel: "cancelModel", dictation_model_remove: "removeModel",
};

const dictationEvents: Record<string, string> = { "pi://dictation": "dictation", "pi://dictation-stream": "dictation-stream", "pi://dictation-models": "dictation-models" };

export const listen = <S extends z.ZodType>(event: string, handler: EventCallback<z.output<S>>, schema: S): Promise<UnlistenFn> => {
  const dictationEvent = dictationEvents[event];

  if (isMobile && dictationEvent) return dictationPlugin.addListener(dictationEvent, payload => handler({ event, id: 0, payload: schema.parse(payload) })).then(handle => () => void handle.remove());

  return isMobile ? remoteClient.listen(event, handler, schema) : nativeListen(event, value => handler({ ...value, payload: schema.parse(value.payload) }), { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } });
};

export function captureDaemonTransport() {
  const identity = isMobile ? remoteClient.connectionIdentity() : "desktop";
  const active = () => !isMobile || identity !== undefined && remoteClient.connectionIdentity() === identity;

  const scopedInvoke = async <S extends z.ZodType>(command: string, args: NativeArguments, schema: S): Promise<z.output<S>> => {
    if (!active()) throw new Error("Reconnect to this note's original host to save it.");
    const result = await invoke(command, args, schema);

    if (!active()) throw new Error("The note's host connection changed.");

    return result;
  };

  return { identity, active, invoke: scopedInvoke };
}

export function invoke<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
export function invoke(command: string, args?: NativeArguments): Promise<JSONType | undefined>;
export async function invoke(command: string, args?: NativeArguments, schema: z.ZodType = jsonResultSchema) {
  try { return await invokeDaemon(command, args, schema); }
  catch (reason) { throw daemonError(reason); }
}

async function invokeDaemon(command: string, args: NativeArguments | undefined, schema: z.ZodType) {
  const destination = isMobile ? remoteClient.connectionIdentity() : undefined;
  args = nativeArgumentsSchema.parse({ ...args, clientId: await clientIdentity(isMobile ? "mobile" : "desktop") });

  if (!isMobile) {
    const local = ["load_client_settings", "save_client_settings", "sync_prompt_history", "new_window", "open_external_url", "open_project_directory", "open_rollout_file", "read_dropped_file"];

    const response = await (local.includes(command) || command in dictationCommands ? nativeInvoke(command, args) : invokeWithBackpressure(() => nativeInvoke("daemon_invoke", { command, args })));

    return schema.parse(response);
  }

  return invokeMobile(command, args, schema, destination);
}

function invokeMobile(command: string, args: NativeArguments, schema: z.ZodType, destination: string | undefined) {
  if (command === "load_client_settings") return clientPreferences.load().then(result => schema.parse(result));

  const dictationMethod = dictationCommands[command];

  if (dictationMethod) return (dictationPlugin as unknown as Record<string, (options: NativeArguments) => Promise<unknown>>)[dictationMethod](args).then(result => schema.parse(result));

  if (command === "save_client_settings") return clientPreferences.save({ settings: args.settings, baseline: args.baseline, initialize: z.boolean().default(false).parse(args.initialize) }).then(result => schema.parse(result));

  if (command === "open_external_url") {
    const url = String(args?.url);

    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only HTTP and HTTPS links can be opened."));

    return Browser.open({ url }).then(() => schema.parse(undefined));
  }

  if (destination !== remoteClient.connectionIdentity()) throw new Error("The host connection changed before this request could be sent. Retry on the selected host.");

  return remoteClient.invoke(command, args, schema);
}
