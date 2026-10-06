import { $, browser } from "@wdio/globals";
import { mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { encodeAgentValue } from "../../../src/lib/agentProtocol.js";
import type { AppSettings, DefinedAgentsCapability } from "../../../src/types.js";
import { z, appSettingsSchema, modelSchema } from "../../../src/lib/responseSchemas.js";
import { agentConfigSchema } from "../../../src/lib/agentSchemas.js";
import { nativeArgumentsSchema, jsonResultSchema } from "../../../src/lib/transportSchemas.js";
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

  if (Object.keys(responses).some(key => key.startsWith("shared_terminal:"))) {
    responses = { ...Object.fromEntries(["list", "start", "resize", "close", "write_with_draft", "draft", "reassign"].map(action => [`shared_terminal:${action}`, {}])), ...responses };
  }

  if (Array.isArray(responses.list_sessions)) responses.list_sessions = responses.list_sessions.map(session => ({ lastMessageAt: 0, apiCost: 0, ...session }));

  if (responses.start_pi) {
    const start = { attached: false, owned: true, ...startSchema.parse(responses.start_pi) };

    if (agentEvent) start.events = [agentEvent];
    responses.start_pi = start;
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
    const stored = await browser.execute(() => window.__TAURI_INTERNALS__.invoke("load_client_settings"));
    const preferences = clientPreferencesSchema.parse(stored ?? {});
    preferences.knownModels = [...new Set([...preferences.knownModels, ...ids])];
    preferences.hiddenModels = preferences.hiddenModels.filter(id => !ids.includes(id));
    await browser.execute(settings => window.__TAURI_INTERNALS__.invoke("save_client_settings", { settings }), preferences);
  }

  await callBridge().setValue("[]");
  await responseBridge().setValue(JSON.stringify(withSessionSnapshot({ ...isolatedUsageResponses, ...responses, __terminalFixture: String(++terminalFixture) })));

  if (responses.list_sessions) await browser.execute(async () => {
    const tauri = window.__TAURI_INTERNALS__;
    await tauri.invoke("plugin:event|emit", { event: "pi://sessions-changed", payload: {} });
  });
};

export const withClientSettingsWriteFailure = async (action: () => Promise<void>) => {
  const path = join(testHome, ".piop", "client-settings.json");
  const backup = `${path}.e2e-backup`;
  renameSync(path, backup);

  try {
    mkdirSync(path);

    try { await action(); } finally { rmdirSync(path); }
  } finally { renameSync(backup, path); }
};

export const backendCalls = async () => z.array(backendCallSchema).parse(JSON.parse(await callBridge().getValue() || "[]"));

export const failureState = async () => JSON.stringify({
  errors: await browser.execute(() => [...document.querySelectorAll(".error-toast,.dialog-error,.upload-error,.runtime-activity")].map(element => element.textContent)),
  lifecycle: (await backendCalls()).filter(call => ["start_pi", "stop_pi", "archive_session", "validate_project_directory", "create_temporary_chat"].includes(call.command)).map(call => ({ command: call.command, mocked: call.mocked, args: call.args })),
  calls: (await backendCalls()).slice(-20).map(call => ({ command: call.command, type: call.args.command?.type, mocked: call.mocked, cwd: call.args.cwd, sessionId: call.args.sessionId, sessionPath: call.args.sessionPath })),
});

export const updateBackendResponse = async <T,>(command: string, response: T) => {
  const responses = responsesSchema.parse(JSON.parse(await responseBridge().getValue() || "{}"));
  await responseBridge().setValue(JSON.stringify(withSessionSnapshot({ ...responses, [command]: response })));
};

export const resetBackend = async () => {
  const prompts = (await backendCalls()).filter(call => call.mocked && isUserPrompt(call.args.command));

  for (const prompt of prompts) await emitPiEvent({ type: "message_start", message: { role: "user", content: promptSchema.parse(prompt.args.command).message, timestamp: Date.now() } });
  agentEvent = undefined;
  await callBridge().setValue("[]");
  await responseBridge().setValue(JSON.stringify(isolatedUsageResponses));
};

export const resetApp = async () => {
  try { await resetBackend(); }
  catch (cause) { throw new Error(`Backend reset failed: ${await $("body").getText()}`, { cause }); }

  await browser.execute(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("piop-last-session:") || key.startsWith("piop-conversation-drafts:")) localStorage.removeItem(key); });
  await app.refreshForReset();

  try { await app.root.waitForDisplayed({ timeout: 10_000 }); }
  catch (cause) { throw new Error(`App reset failed: ${await $("body").getText()}`, { cause }); }

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
  await browser.execute(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

export let defaultSettings: AppSettings;

before(async () => {
  defaultSettings = appSettingsSchema.parse(await browser.execute(async () => {
    const tauri = window.__TAURI_INTERNALS__;

    return tauri.invoke("daemon_invoke", { command: "load_app_settings", args: { clientId: "desktop:e2e-settings" } });
  }));
});

export const acceptanceAgents = (): DefinedAgentsCapability => ({
  version: 1,
  active: "general",
  config: {
    agents: [
      { name: "general", model: "", effort: "high", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: ["read"], skills: [], mcpServers: {} },
      { name: "reviewer", model: "", effort: "off", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: ["read"], skills: [], mcpServers: {} },
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
  load_git_diffs: {}, save_git_diffs: {},
  "pi_command:get_state": { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 },
  "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:get_available_models": { models: [{ provider: "e2e", id: "acceptance", name: "Acceptance model", reasoning: true }, { provider: "e2e", id: "alternate", name: "Alternate model", reasoning: true }] },
  "pi_command:get_available_thinking_levels": { levels: ["off", "high"] }, "pi_command:get_commands": { commands: [{ name: "fast", source: "extension", sourceInfo: { source: "npm:pi-openai-fast-mode-piop" } }] }, "pi_command:get_session_stats": {},
  "pi_command:prompt": {},
  "pi_command:extension_ui_response": {},
  "pi_command:select_agent": {}, "pi_command:take_ownership": {},
  "pi_command:set_model": {},
  "pi_command:set_auto_compaction": {}, "pi_command:set_auto_retry": {}, "pi_command:set_thinking_level": {},
});

export const startTemporaryConversation = async (responses: BackendResponses) => {
  await mockBackend({
    create_temporary_chat: { cwd: "/tmp/acceptance-terminal", sessionId: "acceptance-terminal" },
    list_sessions: [],
    load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" },
    ...connectedSessionResponses("acceptance-terminal"),
    "pi_command:set_model": {},
    ...responses,
  });
  await $('button[aria-label="New conversation"]').click();
  await app.composer.waitForEnabled();
  await emitPiEvent({ type: "session_switched" });
};
