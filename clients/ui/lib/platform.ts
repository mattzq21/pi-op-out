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

const clientPreferences = registerPlugin<{
  load(): Promise<{ settings: unknown; revision: string }>;
  save(options: { settings: unknown; baseline: unknown; initialize: boolean }): Promise<{ settings: unknown; revision: string; publication: SettingsPublication }>;
}>("ClientPreferences");

export async function listen<S extends z.ZodType>(event: string, handler: EventCallback<z.output<S>>, schema: S): Promise<UnlistenFn> {
  if (isMobile) return remoteClient.listen(event, handler, schema);

  let liveHosts = event === "pi://daemon-log-status" ? new Set<string>() : undefined;
  const hostSchema = z.object({ hostId: z.string() });
  const listener: EventCallback<unknown> = value => handler({ ...value, payload: schema.parse(value.payload) });
  const unlisten = await nativeListen(event, value => {
    if (liveHosts) liveHosts.add(hostSchema.parse(value.payload).hostId);
    listener(value);
  }, { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } });

  if (liveHosts) {
    try {
      const statuses = z.array(z.unknown()).parse(await nativeInvoke("daemon_log_statuses"));
      for (const payload of statuses) {
        if (!liveHosts.has(hostSchema.parse(payload).hostId)) listener({ event, payload, id: 0 });
      }
    } catch (error) {
      unlisten();
      throw error;
    } finally {
      liveHosts = undefined;
    }
  }
  return unlisten;
}

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
    const local = ["load_client_settings", "save_client_settings", "new_window", "open_external_url", "open_project_directory", "open_rollout_file", "open_local_file", "read_dropped_file"];

    const response = await (local.includes(command) ? nativeInvoke(command, args) : invokeWithBackpressure(() => nativeInvoke("daemon_invoke", { command, args })));

    return schema.parse(response);
  }

  return invokeMobile(command, args, schema, destination);
}

function invokeMobile(command: string, args: NativeArguments, schema: z.ZodType, destination: string | undefined) {
  if (command === "load_client_settings") return clientPreferences.load().then(result => schema.parse(result));

  if (command === "save_client_settings") return clientPreferences.save({ settings: args.settings, baseline: args.baseline, initialize: z.boolean().default(false).parse(args.initialize) }).then(result => schema.parse(result));

  if (command === "open_external_url") {
    const url = String(args?.url);

    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only HTTP and HTTPS links can be opened."));

    return Browser.open({ url }).then(() => schema.parse(undefined));
  }

  if (destination !== remoteClient.connectionIdentity()) throw new Error("The host connection changed before this request could be sent. Retry on the selected host.");

  return remoteClient.invoke(command, args, schema);
}
