import { z, type JSONType } from "zod";
import { rpcEventSchema } from "../../../clients/ui/lib/rpcSchemas";
import type { NativeArguments } from "../../../clients/ui/lib/transportSchemas";
import { mockSharedTerminal } from "../native-terminal-fixture";
import { draftCatalog } from "./draft-catalog";

/*
 * Test-only entry of the E2E build. The specs control the backend through two text fields:
 * "E2E responses" holds mocked results by command key, and "E2E calls" records each command that the app sends.
 * Commands without a mocked result go to the real desktop backend.
 * The E2E build maps "@tauri-apps/api/core" to this module, because Tauri does not let a page replace window.__TAURI_INTERNALS__.invoke.
 */

import * as tauriCore from "../../../node_modules/@tauri-apps/api/core.js";

export * from "../../../node_modules/@tauri-apps/api/core.js";

type Invoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;

declare global {
  interface Window { __piopE2eErrors: string[] }
}

// Page errors are kept for failure reports.
window.__piopE2eErrors = [];
const describeError = (error: unknown) => error instanceof Error ? error.message + " " + (error.stack ?? "") : typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
window.addEventListener("error", event => window.__piopE2eErrors.push("error: " + describeError(event.error ?? event.message)));
window.addEventListener("unhandledrejection", event => window.__piopE2eErrors.push("rejection: " + describeError(event.reason)));
const consoleError = console.error.bind(console);
console.error = (...values: unknown[]) => { window.__piopE2eErrors.push("console: " + values.map(describeError).join(" ")); consoleError(...values); };

/** Commands that the app sends through its platform invoke (clients/ui/lib/platform.ts). */
const localCommands = new Set(["load_client_settings", "save_client_settings", "new_window", "open_external_url", "open_project_directory", "open_rollout_file", "read_dropped_file"]);

const mockMetadataSchema = z.object({ error: z.string().optional(), events: z.array(rpcEventSchema).optional() }).catch({});

function responseKey(command: string, args?: NativeArguments) {
  if (command === "shared_terminal" || command === "recover_missing_session") return command + ":" + String(args?.action);

  if (command === "broker_request") return command + ":" + String(z.object({ action: z.string() }).catch({ action: "unknown" }).parse(args?.body).action);

  return command === "pi_command" ? command + ":" + String(args?.command?.type) : command;
}

const locationsSchema = z.object({ bySession: z.record(z.string(), z.json()) });

/** A mocked conversation lookup answers per conversation; conversations without a mocked location go to the real daemon. */
function mockedValue(key: string, args: NativeArguments | undefined, responses: Record<string, JSONType>) {
  if (!(key in responses)) return undefined;
  const locations = key === "broker_request:locate" ? locationsSchema.safeParse(responses[key]) : undefined;

  if (!locations?.success) return { value: responses[key] };
  const sessionId = z.object({ sessionId: z.string() }).catch({ sessionId: "" }).parse(args?.body).sessionId;

  return sessionId in locations.data.bySession ? { value: locations.data.bySession[sessionId] } : undefined;
}

const field = (label: string) => {
  const element = document.createElement("textarea");
  element.id = label === "E2E responses" ? "pi-e2e-responses" : "pi-e2e-calls";
  element.setAttribute("aria-label", label);
  element.placeholder = label;
  Object.assign(element.style, { width: "110px", height: "28px", opacity: ".45", fontSize: "9px" });

  return element;
};

const responseField = field("E2E responses");
const callField = field("E2E calls");
const bridge = document.createElement("div");
bridge.className = "e2e-bridge";
Object.assign(bridge.style, { position: "fixed", zIndex: "20", left: "4px", bottom: "4px", display: "flex", gap: "2px" });
bridge.append(responseField, callField);
document.body.append(bridge);

const realInvoke: Invoke = (command, args, options) => tauriCore.invoke(command, args as Record<string, unknown>, options as Parameters<typeof tauriCore.invoke>[2]);

async function mockResponse(command: string, response: JSONType, args: NativeArguments | undefined, responses: Record<string, JSONType>) {
  const metadata = mockMetadataSchema.parse(response);

  if (metadata.error) throw metadata.error;

  if (command === "shared_terminal") return mockSharedTerminal(args, responses);

  if (command === "start_pi" && metadata.events) {
    await Promise.all(metadata.events.map(event => realInvoke("plugin:event|emit", { event: "pi://event", payload: { runtimeId: args?.runtimeId, event } })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  return response;
}

export const invoke = async <T>(cmd: string, payload?: Record<string, unknown>, options?: unknown): Promise<T> => (await bridgedInvoke(cmd, payload, options)) as T;

/** A command loop in the app would grow the call record without end and freeze the page, so the bridge reports it and stops recording that command. */
const runawayLimit = 300;
const callCounts = new Map<string, number>();

const bridgedInvoke: Invoke = async (cmd, payload, options) => {
  const routed = cmd === "daemon_invoke" ? z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).optional() }).parse(payload) : localCommands.has(cmd) ? { command: cmd, args: payload } : undefined;

  if (!routed) return realInvoke(cmd, payload, options);
  const args = routed.args as NativeArguments | undefined;
  if (routed.command === "provider_auth" && (args?.request as { action?: string })?.action === "draft_catalog") return draftCatalog;
  const key = responseKey(routed.command, args);
  const responses = z.record(z.string(), z.json()).parse(JSON.parse(responseField.value || "{}"));

  const mocked = mockedValue(key, args, responses);

  if (callField.value) {
    const calls = z.array(z.json()).parse(JSON.parse(callField.value));

    // Counts start again when a spec clears the record.
    if (!calls.length) callCounts.clear();
    const count = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, count);

    if (count === runawayLimit) window.__piopE2eErrors.push("runaway: " + key + " was called " + runawayLimit + " times");

    if (count < runawayLimit) callField.value = JSON.stringify([...calls, { command: routed.command, args, mocked: Boolean(mocked) }]);
  }

  if (!mocked) return realInvoke(cmd, payload, options);

  return mockResponse(routed.command, mocked.value, args, responses);
};
