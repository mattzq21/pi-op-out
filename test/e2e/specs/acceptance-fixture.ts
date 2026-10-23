import { $, browser } from "@wdio/globals";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { encodeAgentValue } from "../../../clients/ui/lib/agentProtocol.js";
import type { AppSettings, DefinedAgentsCapability } from "../../../clients/ui/types.js";
import { z } from "zod";
import { appSettingsSchema, modelSchema } from "../../../clients/ui/lib/responseSchemas.js";
import { agentConfigSchema } from "../../../clients/ui/lib/agentSchemas.js";
import { nativeArgumentsSchema, jsonResultSchema } from "../../../clients/ui/lib/transportSchemas.js";
import { app } from "../pageobjects/app.page.js";

const backendCallSchema = z.object({ command: z.string(), args: nativeArgumentsSchema.default({}), mocked: z.boolean() });

const responsesSchema = z.record(z.string(), z.unknown());

type BackendResponses = z.infer<typeof responsesSchema>;

export type BackendCall = z.infer<typeof backendCallSchema>;

const promptSchema = z.object({ type: z.literal("prompt"), message: z.string().optional() });

type UserPrompt = z.infer<typeof promptSchema>;

const modelsSchema = z.object({ models: z.array(modelSchema).optional() });

const savedSettingsSchema = z.looseObject({ settings: appSettingsSchema.optional() });

const startSchema = z.looseObject({ events: z.array(z.unknown()).optional() });

const clientPreferencesSchema = z.looseObject({ knownModels: z.array(z.string()).default([]), hiddenModels: z.array(z.string()).default([]) });

declare global {
  interface Window {
    __e2eClipboard?: string;
    __TAURI_INTERNALS__: { invoke<T>(command: string, args?: T): Promise<z.infer<typeof jsonResultSchema>> };
  }
}

export const isUserPrompt = (value: unknown): value is UserPrompt => {
  const command = promptSchema.safeParse(value);

  return command.success && !/^\/(?:fast|pi-desktop-fast-status|pi-define-agents-use)(?:\s|$)/.test(command.data.message ?? "");
};

const testHome = process.env.PIOP_TEST_HOME || (() => { throw new Error("E2E requires an isolated home"); })();

export const installedAgentConfigPath = join(testHome, ".piop", "piop-define-agents", "config.json");

export const callBridge = () => $('textarea[aria-label="E2E calls"]');

export const responseBridge = () => $('textarea[aria-label="E2E responses"]');

/** WebDriver setValue types each character, which takes minutes for large mocked responses, so the fields are set directly. */
export const setBridgeValue = async (label: "E2E calls" | "E2E responses", value: string) => {
  await browser.execute((fieldLabel, fieldValue) => {
    const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${fieldLabel}"]`);

    if (!field) throw new Error("Missing E2E bridge field: " + fieldLabel);
    field.value = fieldValue;

    return null;
  }, label, value);
};

export const isolatedUsageResponses = {
  codex_usage: { error: "Usage lookup disabled in conversation fixtures" },
  opencode_go_usage: { error: "Usage lookup disabled in conversation fixtures" },
};

const withKnownModels = (responses: BackendResponses) => {
  responses = { ...responses };
  const models = modelsSchema.parse(responses["pi_command:get_available_models"] ?? {}).models ?? [];
  const known = (settings: AppSettings) => ({ ...settings, knownModels: [...new Set([...(settings.knownModels ?? []), ...models.map(model => `${model.provider}/${model.id}`)])] });

  const settings = appSettingsSchema.safeParse(responses.load_app_settings);

  if (settings.success) responses.load_app_settings = known(settings.data);
  const saved = savedSettingsSchema.parse(responses.save_app_settings ?? {});

  if (saved?.settings) responses.save_app_settings = { ...saved, settings: known(saved.settings) };

  return responses;
};

export const withSessionSnapshot = (responses: BackendResponses) => {
  responses = withKnownModels(responses);

  // The app reads the daemon's settings through load_settings_change, which wraps them as { settings }.
  if (responses.load_app_settings) responses.load_settings_change = { settings: responses.load_app_settings };

  if (Object.keys(responses).some(key => key.startsWith("shared_terminal:"))) {
    responses = { ...Object.fromEntries(["list", "start", "resize", "close", "write_with_draft", "draft", "reassign"].map(action => [`shared_terminal:${action}`, {}])), ...responses };
  }

  if (Array.isArray(responses.list_sessions)) {
    responses.list_sessions = responses.list_sessions.map(session => ({ lastMessageAt: 0, apiCost: 0, ...session }));
    // The app looks up a saved conversation's file and folder before it connects to it.
    const sessions = z.array(z.looseObject({ id: z.string(), path: z.string().optional(), cwd: z.string().optional(), archived: z.boolean().optional() })).catch([]).parse(responses.list_sessions);
    responses["broker_request:locate"] = { bySession: Object.fromEntries(sessions.map(session => [session.id, { sessionId: session.id, sessionPath: session.path ?? `/tmp/${session.id}.jsonl`, cwd: session.cwd ?? "/tmp", archived: session.archived ?? false, revision: "e2e" }])) };
  }

  if (responses.start_pi) {
    const start = { attached: false, owned: true, ...startSchema.parse(responses.start_pi) };

    if (agentEvent) start.events = [agentEvent];
    responses.start_pi = start;
    responses["pi_command:get_agent_configuration"] ??= acceptanceAgents().config;
  }

  const state = responses["pi_command:get_state"];

  if (!state) return responses;

  return { ...responses, "pi_command:get_session_revision": { revision: "changed" }, "pi_command:get_snapshot": { revision: "snapshot", state, history: responses["pi_command:get_entries"] ?? { entries: [], leafId: null }, queue: { type: "queue_state", pendingMessages: [] }, liveTools: [], sequence: 0, epoch: "e2e" } };
};

let terminalFixture = 0;

export const mockBackend = async (responses: BackendResponses) => {
  const models = modelsSchema.parse(responses["pi_command:get_available_models"] ?? {}).models;

  if (models) {
    const ids = models.map(model => `${model.provider}/${model.id}`);
    const stored = z.object({ settings: z.looseObject({}).nullable() }).parse(await browser.execute(() => window.__TAURI_INTERNALS__.invoke("load_client_settings")));
    if (!stored.settings) throw new Error("The app has not saved its client preferences yet");
    const preferences = clientPreferencesSchema.parse(stored.settings);
    preferences.knownModels = [...new Set([...preferences.knownModels, ...ids])];
    preferences.hiddenModels = preferences.hiddenModels.filter(id => !ids.includes(id));
    await browser.execute((settings, baseline) => window.__TAURI_INTERNALS__.invoke("save_client_settings", { settings, baseline }).then(() => null), preferences, stored.settings);
  }

  await setBridgeValue("E2E calls", "[]");
  await setBridgeValue("E2E responses", JSON.stringify(withSessionSnapshot({ ...isolatedUsageResponses, ...responses, __terminalFixture: String(++terminalFixture) })));

  if (responses.list_sessions) await browser.execute(async () => {
    const tauri = window.__TAURI_INTERNALS__;
    await tauri.invoke("plugin:event|emit", { event: "pi://sessions-changed", payload: {} });
  });
};

export const withClientSettingsWriteFailure = async (action: () => Promise<void>) => {
  const previous = await responseBridge().getValue();
  await updateBackendResponse("save_client_settings", { error: "Permission denied while saving client preferences" });
  try { await action(); }
  finally { await setBridgeValue("E2E responses", previous); }
};

export const backendCalls = async () => z.array(backendCallSchema).parse(JSON.parse(await callBridge().getValue() || "[]"));

export const failureState = async () => JSON.stringify({
  errors: await browser.execute(() => [...document.querySelectorAll(".error-toast,.dialog-error,.upload-error,.runtime-activity")].map(element => element.textContent)),
  lifecycle: (await backendCalls()).filter(call => ["start_pi", "stop_pi", "archive_session", "validate_project_directory", "create_temporary_chat"].includes(call.command)).map(call => ({ command: call.command, mocked: call.mocked, args: call.args })),
  calls: (await backendCalls()).slice(-20).map(call => ({ command: call.command, type: call.args.command?.type, mocked: call.mocked, cwd: call.args.cwd, sessionId: call.args.sessionId, sessionPath: call.args.sessionPath })),
});

export const updateBackendResponse = async <T,>(command: string, response: T) => {
  const responses = responsesSchema.parse(JSON.parse(await responseBridge().getValue() || "{}"));
  await setBridgeValue("E2E responses", JSON.stringify(withSessionSnapshot({ ...responses, [command]: response })));
};

export const resetBackend = async () => {
  const prompts = (await backendCalls()).filter(call => call.mocked && isUserPrompt(call.args.command));

  for (const prompt of prompts) await emitPiEvent({ type: "message_start", message: { role: "user", content: promptSchema.parse(prompt.args.command).message, piopSubmissionId: prompt.args.command?.goalSubmissionId, timestamp: Date.now() } });
  agentEvent = undefined;
  await setBridgeValue("E2E calls", "[]");
  await setBridgeValue("E2E responses", JSON.stringify(isolatedUsageResponses));
};

/** Page state for failure messages: page errors, the app root classes and the start of the visible text. */
const pageDiagnostics = async () => JSON.stringify(await browser.execute(() => ({
  errors: (window.__piopE2eErrors ?? []).slice(-10).map(error => error.slice(0, 600)),
  bridge: Boolean(document.querySelector("#pi-e2e-responses")),
  root: document.querySelector(".app")?.className ?? null,
  text: document.body.innerText.slice(0, 400),
})).catch(error => ({ diagnosticsFailed: String(error) })));

export const resetApp = async () => {
  const appUrl = await browser.getUrl();
  // Keep the current IPC fixtures until the old runtimes have detached.
  try {
    const runtimes = [...new Map((await backendCalls()).filter(call => call.command === "start_pi" && !call.mocked).map(call => {
      const { runtimeId, clientId } = call.args;
      if (typeof runtimeId !== "string" || typeof clientId !== "string") throw new Error("Started runtime is missing its IPC identity");
      return [runtimeId, { runtimeId, clientId }] as const;
    })).values()];
    await browser.execute(async owners => {
      for (const args of owners) await window.__TAURI_INTERNALS__.invoke("daemon_invoke", { command: "stop_pi", args });
    }, runtimes);
    await resetBackend();
  } catch (cause) { throw new Error(`Backend reset failed: ${String(cause)} ${await pageDiagnostics()}`, { cause }); }

  // The E2E build includes a script-free same-origin page. Unloading the app
  // destroys its timers and writers before storage is cleared.
  const cleanupUrl = new URL("/e2e-cleanup.html", appUrl).href;
  try {
    await browser.url(cleanupUrl);
    await $('[data-piop-fixture-cleanup]').waitForExist();
    await browser.execute(async () => {
      for (const name of ["piop-drafts", "piop-session-resume"]) {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error(`Could not clear fixture storage: ${name}`));
          request.onblocked = () => reject(new Error(`Another page still holds fixture storage open: ${name}`));
        });
      }
      for (const key of Object.keys(localStorage)) if (key.startsWith("piop-last-session:") || key.startsWith("piop-conversation-drafts:")) localStorage.removeItem(key);
      for (const key of Object.keys(sessionStorage)) if (key.startsWith("piop-target-initialized:")) sessionStorage.removeItem(key);
    });
  } finally {
    await browser.url(appUrl);
  }

  try { await app.root.waitForDisplayed({ timeout: 10_000 }); }
  catch (cause) { throw new Error(`App reset failed: ${String(cause)} ${await pageDiagnostics()}`, { cause }); }

  if (await app.conversationsButton.isExisting()) await app.conversationsButton.click();
  await app.waitUntilReady();
  await app.composer.waitForEnabled();
};

export const emitPiEvent = async (payload: BackendResponses) => {
  await browser.execute(async (event) => {
    const tauri = window.__TAURI_INTERNALS__;
    await tauri.invoke("plugin:event|emit", { event: "pi://event", payload: event });

    if (event.type === "agent_end") await tauri.invoke("plugin:event|emit", { event: "pi://event", payload: { type: "agent_settled" } });
  }, payload);
};

export let defaultSettings: AppSettings;

before(async () => {
  const result = await browser.execute(async () => {
    const tauri = window.__TAURI_INTERNALS__;
    try { return { value: await tauri.invoke("daemon_invoke", { command: "load_app_settings", args: { clientId: "desktop:e2e-settings" } }) }; }
    catch (error) { return { error: String(error) }; }
  });
  if ("error" in result) throw new Error("Could not load isolated daemon settings: " + result.error);
  defaultSettings = appSettingsSchema.parse(result.value);
});

export const acceptanceAgents = (): DefinedAgentsCapability => ({
  version: 1,
  active: "general",
  config: {
    agents: [
      { name: "general", isDefault: true, model: "", effort: "high", path_systemprompt: "~/.agents/prompts/system/default.md", path_agent_prompt: "", tools: ["read"], skills: [], mcpServers: {} },
      { name: "reviewer", model: "", effort: "off", path_systemprompt: "~/.agents/prompts/system/default.md", path_agent_prompt: "", tools: ["read"], skills: [], mcpServers: {} },
    ],
  },
});

export const installedAgents = (): DefinedAgentsCapability => {
  const config = agentConfigSchema.partial().parse(JSON.parse(readFileSync(installedAgentConfigPath, "utf8")));
  const agents = config.agents ?? [];

  return {
    version: 1,
    active: agents.some((agent) => agent.name === "general") ? "general" : agents[0]?.name ?? "general",
    config: {
      agents,
    },
  };
};

let agentEvent: BackendResponses | undefined;

export const enableAgents = async (capability = acceptanceAgents()) => {
  agentEvent = { type: "extension_ui_request", id: "acceptance-agents", method: "setStatus", statusKey: "pi-define-agents", statusText: `json:${encodeAgentValue(capability)}` };
  const responses = JSON.parse(await responseBridge().getValue() || "{}");

  if (responses.start_pi) await updateBackendResponse("start_pi", { ...responses.start_pi, events: [agentEvent] });
  await emitPiEvent(agentEvent);
};

export const setSelectValue = (selector: string, value: string) => browser.execute((target, next) => {
  const select = document.querySelector(target);

  if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found: ${target}`);
  select.value = next; select.dispatchEvent(new Event("change", { bubbles: true }));
}, selector, value);

export const pressShortcut = (shortcut: string) => browser.execute((value) => {
  const parts = value.split("+"); const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase()); const key = value.endsWith("+") ? "+" : parts.at(-1) === "Space" ? " " : parts.at(-1);

  if (!key) throw new Error("Shortcut has no key");
  const mod = modifiers.includes("mod"); const mac = navigator.platform.toLowerCase().includes("mac");
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: modifiers.includes("ctrl") || (mod && !mac), metaKey: modifiers.includes("meta") || (mod && mac), altKey: modifiers.includes("alt"), shiftKey: modifiers.includes("shift"), bubbles: true }));
}, shortcut);

export const connectedSessionResponses = (sessionId: string) => ({
  start_pi: { attached: false, owned: true }, stop_pi: false,
  "shared_terminal:list": {},

  "pi_command:get_state": { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 },
  "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:get_available_models": { models: [{ provider: "e2e", id: "acceptance", name: "Acceptance model", reasoning: true }, { provider: "e2e", id: "alternate", name: "Alternate model", reasoning: true }] },
  "pi_command:get_available_thinking_levels": { levels: ["off", "high"] }, "pi_command:get_commands": { commands: [{ name: "fast", source: "extension", sourceInfo: { source: "npm:pi-openai-fast-mode-piop" } }] }, "pi_command:get_session_stats": {},
  "pi_command:prompt": {},
  "pi_command:extension_ui_response": {},
  "pi_command:select_agent": {}, "pi_command:take_ownership": {},
  "pi_command:set_model": {}, "pi_command:set_fast_mode": {},
  "pi_command:set_auto_compaction": {}, "pi_command:set_auto_retry": {}, "pi_command:set_thinking_level": {},
});

export const startTemporaryConversation = async (responses: BackendResponses) => {
  const sessionId = randomUUID();
  const cwd = `/tmp/acceptance-terminal-${sessionId}`;
  const name = `Started test conversation ${sessionId}`;
  await mockBackend({
    create_temporary_chat: { cwd, sessionId },
    remove_temporary_chat: null,
    list_sessions: [],
    load_app_settings: { ...defaultSettings, defaultThinking: "high" },
    ...connectedSessionResponses(sessionId),
    "pi_command:set_model": {}, "pi_command:set_fast_mode": {},
    ...responses,
  });
  await $('button[aria-label="New conversation"]').click();
  await app.composer.waitForEnabled();
  // A new conversation is a draft until its first message is sent.
  await app.chooseComposerOption("Model", "Acceptance model");
  await app.prepareMessage("Start the test conversation");
  await app.sendMessageButton.click();
  await browser.waitUntil(async () => (await backendCalls()).some(call => call.command === "pi_command" && call.args.command?.type === "prompt"));
  const prompt = (await backendCalls()).find(call => call.command === "pi_command" && call.args.command?.type === "prompt");
  const runtimeId = prompt?.args.runtimeId;
  const submissionId = prompt?.args.command?.goalSubmissionId;
  if (typeof runtimeId !== "string" || typeof submissionId !== "string") throw new Error("The sent conversation has no runtime or submission identity");
  const message = { role: "user", content: [{ type: "text", text: "Start the test conversation" }], timestamp: Date.now(), piopSubmissionId: submissionId };
  await browser.execute(async ({ id, message }) => {
    for (const event of [
      { type: "settings_applied" },
      { type: "message_start", message },
      { type: "agent_end", messages: [] },
      { type: "agent_settled" },
    ]) await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://event", payload: { runtimeId: id, event } });
    return null;
  }, { id: runtimeId, message });
  await app.composer.waitForEnabled();
  await updateBackendResponse("pi_command:get_state", { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 1, pendingMessageCount: 0 });
  await updateBackendResponse("pi_command:get_entries", responses["pi_command:get_entries"] ?? { entries: [{ type: "message", id: "initial-prompt", parentId: null, message }], leafId: "initial-prompt" });
  await updateBackendResponse("list_sessions", [{ id: sessionId, path: `${cwd}/session.jsonl`, name, project: "Terminal project", preview: "Start the test conversation", cwd, hostId: "local", messageCount: 1 }]);
  await browser.execute(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://sessions-changed", payload: {} });
    return null;
  });
  await app.conversationSearch.setValue(name);
  await $(`.session-main[aria-label^="${name},"]`).click();
  await app.openTerminalButton.waitForEnabled();
  return { sessionId, cwd, runtimeId };
};
