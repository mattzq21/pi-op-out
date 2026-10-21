import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen, type EventCallback } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { registerPlugin } from "@capacitor/core";
import { z } from "zod";
import { isMobile } from "../lib/platform";
import { jsonResultSchema, type NativeArguments } from "../lib/transportSchemas";

type MobilePlugin = Record<string, (args?: NativeArguments) => Promise<unknown>> & {
  addListener(event: string, callback: (payload: unknown) => void): Promise<{ remove(): Promise<void> }>;
};

export function nativePlugin(id: string, mobileName: string, methods: Record<string, string>, events: Record<string, string>) {
  const mobile = registerPlugin<MobilePlugin>(mobileName);
  async function invoke<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
  async function invoke(command: string, args?: NativeArguments): Promise<unknown>;
  async function invoke(command: string, args?: NativeArguments, schema: z.ZodType = jsonResultSchema) {
    if (!Object.hasOwn(methods, command)) throw new Error(`Unknown ${id} command: ${command}`);
    return schema.parse(await (isMobile ? mobile[methods[command]](args) : nativeInvoke(`plugin:${id}|${command}`, args)));
  }
  async function listen<S extends z.ZodType>(event: string, handler: EventCallback<z.output<S>>, schema: S) {
    if (!Object.hasOwn(events, event)) throw new Error(`Unknown ${id} event: ${event}`);
    if (isMobile) {
      const handle = await mobile.addListener(events[event], payload => handler({ event, id: 0, payload: schema.parse(payload) }));
      return () => { void handle.remove(); };
    }
    return nativeListen(event, value => handler({ ...value, payload: schema.parse(value.payload) }), { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } });
  }
  return { invoke, listen };
}
