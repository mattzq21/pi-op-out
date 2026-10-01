import { emit as emitNativeEvent } from "@tauri-apps/api/event";
import type { RpcCommand, RpcEvent } from "../types";
import { invoke } from "./platform";

export type NativeCall = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function responseKey(command: string, args?: Record<string, unknown>) {
  return command === "pi_command" ? `${command}:${String((args?.command as RpcCommand)?.type)}` : command;
}

function mockResponse<T>(command: string, response: { error?: string; events?: RpcEvent[] }, args?: Record<string, unknown>) {
  if (response?.error) return Promise.reject(new Error(response.error));

  if (command === "start_pi" && Array.isArray(response?.events)) {
    return Promise.all(response.events.map((event: RpcEvent) => emitNativeEvent("pi://event", { runtimeId: args?.runtimeId, event })))
      .then(() => new Promise<T>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(response as T)))));
  }

  return Promise.resolve(response as T);
}

export const nativeCall = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.MODE !== "e2e") return invoke<T>(command, args);
  const key = responseKey(command, args);
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses"); const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = JSON.parse(responseField?.value || "{}");

  if (callField?.value) { const calls = JSON.parse(callField.value); calls.push({ command, args, mocked: key in responses }); callField.value = JSON.stringify(calls); }

  if (!(key in responses)) return invoke<T>(command, args);

  return mockResponse<T>(command, responses[key], args);
};
