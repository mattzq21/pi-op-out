import { $, browser } from "@wdio/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAgentValue } from "../../../src/lib/agentProtocol.js";
import type { AppSettings, DefinedAgentsCapability, AgentConfig } from "../../../src/types.js";
import { app } from "../pageobjects/app.page.js";

export type BackendCall = { command: string; args: Record<string, unknown>; mocked: boolean };

export const isUserPrompt = (value: unknown) => {
  const command = value as { type?: string; message?: string } | undefined;
  return command?.type === "prompt" && !/^\/(?:fast|pi-desktop-fast-status|pi-define-agents-use)(?:\s|$)/.test(command.message ?? "");
};

export const installedAgentConfigPath = join(process.env.PIOP_TEST_HOME || (() => { throw new Error("E2E requires an isolated home"); })(), ".piop", "piop-define-agents", "config.json");

export const callBridge = () => $('textarea[aria-label="E2E calls"]');

export const responseBridge = () => $('textarea[aria-label="E2E responses"]');

export const isolatedUsageResponses = {
  codex_usage: { error: "Usage lookup disabled in conversation fixtures" },
  opencode_go_usage: { error: "Usage lookup disabled in conversation fixtures" },
};

export const withSessionSnapshot = (responses: Record<string, unknown>) => {
  responses = { ...responses };
  const models = (responses["pi_command:get_available_models"] as { models?: Array<{ provider: string; id: string }> })?.models ?? [];
  const known = (settings: AppSettings) => ({ ...settings, knownModels: [...new Set([...(settings.knownModels ?? []), ...models.map(model => `${model.provider}/${model.id}`)])] });
  if (responses.load_app_settings && !(responses.load_app_settings as { error?: unknown }).error) responses.load_app_settings = known(responses.load_app_settings as AppSettings);
  const saved = responses.save_app_settings as { settings?: AppSettings } | undefined;
  if (saved?.settings) responses.save_app_settings = { ...saved, settings: known(saved.settings) };
  const state = responses["pi_command:get_state"];
  if (!state) return responses;
  return { ...responses, "pi_command:get_snapshot": { state, history: responses["pi_command:get_entries"] ?? { entries: [], leafId: null }, queue: { pendingMessages: [] }, liveTools: [], sequence: 0, epoch: "e2e" } };
};

export const mockBackend = async (responses: Record<string, unknown>) => {
  await callBridge().setValue("[]");
  await responseBridge().setValue(JSON.stringify(withSessionSnapshot({ ...isolatedUsageResponses, ...responses })));
};

export const backendCalls = async () => (JSON.parse(await callBridge().getValue() || "[]") as Partial<BackendCall>[]).filter((call) => call && typeof call === "object").map((call) => ({
  command: typeof call.command === "string" ? call.command : "",
  args: call.args && typeof call.args === "object" ? call.args : {},
  mocked: call.mocked === true,
}));

export const updateBackendResponse = async (command: string, response: unknown) => {
  const responses = JSON.parse(await responseBridge().getValue()) as Record<string, unknown>;
  await responseBridge().setValue(JSON.stringify(withSessionSnapshot({ ...responses, [command]: response })));
};

export const resetBackend = async () => { await callBridge().setValue("[]"); await responseBridge().setValue(JSON.stringify(isolatedUsageResponses)); };

export const resetApp = async () => {
  try { await resetBackend(); }
  catch (cause) { throw new Error(`Backend reset failed: ${await $("body").getText()}`, { cause }); }
  await app.refreshForReset();
  try { await app.root.waitForDisplayed({ timeout: 10_000 }); }
  catch (cause) { throw new Error(`App reset failed: ${await $("body").getText()}`, { cause }); }
  if (await app.conversationsButton.isExisting()) await app.conversationsButton.click();
  await app.waitUntilReady();
  await app.composer.waitForEnabled();
};

export const emitPiEvent = async (payload: Record<string, unknown>) => {
  await browser.execute(async (event) => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await tauri.invoke("plugin:event|emit", { event: "pi://event", payload: event });
    // A completed native turn settles after agent_end; fixtures model both events.
    if (event.type === "agent_end") await tauri.invoke("plugin:event|emit", { event: "pi://event", payload: { type: "agent_settled" } });
  }, payload);
  await browser.execute(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

export let defaultSettings: AppSettings;

before(async () => {
  defaultSettings = await browser.execute(async () => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: <T>(command: string, args?: unknown) => Promise<T> } }).__TAURI_INTERNALS__;
    return tauri.invoke<AppSettings>("daemon_invoke", { command: "load_app_settings", args: { clientId: "desktop:e2e-settings" } });
  });
});

export const acceptanceAgents = (): DefinedAgentsCapability => ({
  version: 1,
  active: "general",
  config: {
    agents: [
      { name: "general", model: "", effort: "high", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: ["read"], skills: [], mcpServers: [] },
      { name: "reviewer", model: "", effort: "off", path_systemprompt: "sysprompt/default.md", path_agentprompt: "", tools: ["read"], skills: [], mcpServers: [] },
    ],
  },
});

export const installedAgents = (): DefinedAgentsCapability => {
  const config = JSON.parse(readFileSync(installedAgentConfigPath, "utf8")) as Partial<AgentConfig>;
  const agents = config.agents ?? [];
  return {
    version: 1,
    active: agents.some((agent) => agent.name === "general") ? "general" : agents[0]?.name ?? "general",
    config: {
      agents,
    },
  };
};

export const enableAgents = async (capability = acceptanceAgents()) => emitPiEvent({
  type: "extension_ui_request",
  id: "acceptance-agents",
  method: "setStatus",
  statusKey: "pi-define-agents",
  statusText: `json:${encodeAgentValue(capability)}`,
});

export const setSelectValue = (selector: string, value: string) => browser.execute((target, next) => {
  const select = document.querySelector<HTMLSelectElement>(target)!; select.value = next; select.dispatchEvent(new Event("change", { bubbles: true }));
}, selector, value);

export const pressShortcut = (shortcut: string) => browser.execute((value) => {
  const parts = value.split("+"); const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase()); const key = value.endsWith("+") ? "+" : parts.at(-1) === "Space" ? " " : parts.at(-1)!;
  const mod = modifiers.includes("mod"); const mac = navigator.platform.toLowerCase().includes("mac");
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: modifiers.includes("ctrl") || (mod && !mac), metaKey: modifiers.includes("meta") || (mod && mac), altKey: modifiers.includes("alt"), shiftKey: modifiers.includes("shift"), bubbles: true }));
}, shortcut);

export const connectedSessionResponses = (sessionId: string) => ({
  start_pi: { attached: false, owned: true }, stop_pi: {},
  load_git_diffs: {}, save_git_diffs: {},
  "pi_command:get_state": { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 },
  "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:get_available_models": { models: [{ provider: "e2e", id: "acceptance", name: "Acceptance model" }, { provider: "e2e", id: "alternate", name: "Alternate model" }] },
  "pi_command:get_available_thinking_levels": { levels: ["off", "high"] }, "pi_command:get_commands": { commands: [{ name: "fast", source: "extension", sourceInfo: { source: "npm:pi-openai-fast-mode-piop" } }] }, "pi_command:get_session_stats": {},
  "pi_command:prompt": {},
  "pi_command:set_auto_compaction": {}, "pi_command:set_auto_retry": {}, "pi_command:set_thinking_level": {},
});

export const startTemporaryConversation = async (responses: Record<string, unknown>) => {
  await mockBackend({
    create_temporary_chat: { cwd: "/tmp/acceptance-terminal", sessionId: "acceptance-terminal" },
    start_pi: {}, stop_pi: {}, list_sessions: [],
    load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" },
    ...connectedSessionResponses("acceptance-terminal"),
    "pi_command:set_model": {},
    ...responses,
  });
  await $('button[aria-label="New conversation"]').click();
  await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "create_temporary_chat"));
  await app.composer.waitForEnabled();
  await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => String((args.command as { message?: string })?.message).startsWith("/pi-define-agents-use ")));
};
