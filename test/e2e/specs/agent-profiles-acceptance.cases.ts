import { $, browser, expect } from "@wdio/globals";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { agentConfigSchema } from "../../../clients/ui/lib/agentSchemas.js";
import type { AgentConfig } from "../../../clients/ui/types.js";
import { draftCatalog } from "../bridge/draft-catalog.js";
import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, defaultSettings, acceptanceAgents, enableAgents, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

const agentCapability = () => {
  const capability = acceptanceAgents();
  capability.config.revision = "acceptance-agent-revision";
  capability.config.agents.find(agent => agent.name === "general")!.tools = ["read", "bash"];
  return capability;
};

const catalogWith = (config: AgentConfig) => ({ ...draftCatalog, config });

async function nativeAgentConfiguration(agents?: ReturnType<typeof agentConfigSchema.parse>["agents"]) {
  const result = await browser.execute(async replacement => {
    const invoke = (command: string, args: Record<string, unknown>) => window.__TAURI_INTERNALS__.invoke("daemon_invoke", { command, args: { ...args, clientId: "desktop:e2e-agent-profiles" } });
    const read = async () => ((await invoke("provider_auth", { hostId: "local", request: { action: "draft_catalog" } })) as { config: { revision: string } }).config;
    try {
      const config = await read();
      if (!replacement) return { value: config };
      await invoke("save_agent_definitions", { hostId: "local", configuration: { revision: config.revision, agents: replacement } });
      return { value: await read() };
    } catch (error) { return { error: String(error) }; }
  }, agents ?? null);
  if ("error" in result) throw new Error("Native agent configuration failed: " + result.error);
  return agentConfigSchema.parse(result.value);
}

describe("Agent profiles acceptance", () => {
  beforeEach(async () => {
    await resetApp();
    const settings = { ...defaultSettings, tools: ["read", "bash"].map(name => ({ name, description: name, source: "built-in" })) };
    await mockBackend({ ...connectedSessionResponses("agents"), load_app_settings: settings, "provider_auth:draft_catalog": catalogWith(agentCapability().config) });
    await browser.execute(async settings => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://settings-changed", payload: { settings } });
    }, settings);
    await enableAgents(agentCapability());
  });
  afterEach(async () => {
    await browser.keys("Escape");
    if (await app.settingsHeading.isExisting()) await app.openConversations();
    await resetBackend();
  });

  it("reveals agent controls when the extension advertises them", async () => {
    await startTemporaryConversation({ "provider_auth:draft_catalog": catalogWith(agentCapability().config) });
    await enableAgents(agentCapability());
    await expect(app.agentPicker).toBeDisplayed();
    await expect(app.agentPicker).toHaveAttribute("data-value", "general");
    await app.agentPicker.click();
    const reviewer = $('[role="listbox"][aria-label="Agent options"] [role="option"][data-value="reviewer"] > span');
    await expect(reviewer).toBeDisplayed();
    expect(await reviewer.getProperty("textContent")).toBe("reviewer");
    await browser.keys("Escape");

    await app.openSettings();
    await expect(app.settingsSection("Agents")).toBeDisplayed();
  });

  it("selects an agent through the agent RPC", async () => {
    await startTemporaryConversation({ "provider_auth:draft_catalog": catalogWith(agentCapability().config) });
    await enableAgents(agentCapability());
    const beforeSelection = (await backendCalls()).length;
    await app.chooseComposerOption("Agent", "reviewer");

    await browser.waitUntil(async () => (await backendCalls()).slice(beforeSelection).some(({ args }) => args.command?.type === "select_agent"));
    expect((await backendCalls()).slice(beforeSelection).find(({ args }) => args.command?.type === "select_agent")?.args.command).toMatchObject({ type: "select_agent", agent: "reviewer" });
  });

  it("creates an agent with inherited resources and editable instructions", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//button[normalize-space(.)="Add agent"]').click();

    const name = $('input[aria-label="Agent name"]');
    await expect(name).toHaveValue(expect.stringMatching(/^agent-\d+$/));
    await name.setValue("acceptance-agent");
    await $('input[aria-label="Agent prompt file"]').setValue("acceptance.md");
    await $('input[aria-label="System prompt file"]').setValue("system.md");
    await expect($('select[aria-label="Agent default effort"]')).toHaveValue("");
    await expect($('select[aria-label="Agent default effort"] option:checked')).toHaveText(expect.stringContaining("Use fallback"));
    await expect($('input[aria-label="Allow read"]')).toBeSelected();
    await expect($('input[aria-label="Allow bash"]')).toBeSelected();

    await $('input[aria-label="Allow bash"]').click();
    await expect($('input[aria-label="Allow bash"]')).not.toBeSelected();
    await expect($('input[aria-label="Agent prompt file"]')).toHaveValue("acceptance.md");
    await expect($('input[aria-label="System prompt file"]')).toHaveValue("system.md");
    await $('button[aria-label="Remove acceptance-agent"]').click();
  });

  it("prevents saving duplicate agent names", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//button[normalize-space(.)="Add agent"]').click();

    const name = $('input[aria-label="Agent name"]');
    await name.setValue("reviewer");
    await expect(app.saveSettingsButton).toBeDisabled();
    await name.setValue("release-reviewer");
    await expect(app.saveSettingsButton).toBeEnabled();
    await $('button[aria-label="Remove release-reviewer"]').click();
  });

  it("saves agent definitions with their revision through the daemon, without a Pi session", async () => {
    const settings = { ...defaultSettings, defaultThinking: "high" };
    await mockBackend({
      ...connectedSessionResponses("agents-save"),
      "provider_auth:draft_catalog": catalogWith(agentCapability().config),
      "pi_command:set_model": {}, save_agent_definitions: { revision: "saved-agent-revision", warnings: [] }, save_app_settings: { settings }, stop_pi: false, start_pi: {}, list_sessions: [], load_app_settings: settings,
    });
    await browser.execute(async settings => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://settings-changed", payload: { settings } });
    }, settings);
    await enableAgents(agentCapability());
    await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/acceptance"));
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent prompt file"]').setValue("review-acceptance.md");

    const beforeSave = (await backendCalls()).length;
    await app.saveSettingsButton.click();
    await expect(app.saveSettingsButton).toHaveText("Saved");
    const calls = (await backendCalls()).slice(beforeSave);
    const saved = agentConfigSchema.parse(calls.find(({ command }) => command === "save_agent_definitions")?.args.configuration);
    expect(saved.revision).toBe("acceptance-agent-revision");
    expect(saved.agents.find((agent) => agent.name === "reviewer")?.path_agent_prompt).toBe("review-acceptance.md");
    expect(calls.filter(({ command }) => command === "save_app_settings")).toHaveLength(0);
    expect(calls.some(({ command }) => command === "start_pi")).toBe(false);
  });

  it("persists a GUI-created agent through a real native save", async () => {
    await resetBackend();
    const originalConfig = await nativeAgentConfiguration();
    const agentName = `e2e-persisted-${randomUUID()}`;
    try {
      await app.refreshForReset();
      await app.waitUntilReady();
      await resetBackend();
      await mockBackend({ "provider_auth:draft_catalog": "native" });
      await browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://agent-definitions-changed", payload: { hostId: "local" } }));
      await app.openSettings();
      await app.openSettingsSection("Agents");
      await browser.waitUntil(async () => (await backendCalls()).some(call => !call.mocked && call.command === "provider_auth" && z.object({ action: z.string() }).safeParse(call.args.request).data?.action === "draft_catalog"),
        { timeout: 30_000, timeoutMsg: "Settings did not read the current agent revision" });
      await $('//button[normalize-space(.)="Add agent"]').click();
      await $('input[aria-label="Agent name"]').setValue(agentName);
      await $('input[aria-label="Agent prompt file"]').setValue("~/.agents/prompts/system/default.md");
      await $('input[aria-label="System prompt file"]').setValue("~/.agents/prompts/system/default.md");
      try { await expect(app.saveSettingsButton).toBeClickable(); }
      catch (error) { throw new Error("Agent save is disabled: " + await browser.execute(() => document.querySelector(".settings-workspace")?.textContent), { cause: error }); }
      await app.saveSettingsButton.click();
      await browser.waitUntil(async () => {
        const error = $('.settings-save [role="alert"]');
        if (await error.isExisting()) throw new Error(await error.getText());
        return await app.saveSettingsButton.getText() === "Saved";
      }, { timeout: 30_000, timeoutMsg: "Native agent save did not finish" });
      const calls = await backendCalls();
      expect(calls.some(({ command, mocked }) => command === "save_agent_definitions" && !mocked)).toBe(true);
      expect(calls.some(({ command }) => command === "start_pi")).toBe(false);
      const saved = await nativeAgentConfiguration();
      expect(saved.agents.find(agent => agent.name === agentName)).toMatchObject({
        path_agent_prompt: "~/.agents/prompts/system/default.md", path_systemprompt: "~/.agents/prompts/system/default.md",
      });
      await app.openConversations();
      await app.openSettings();
      await app.openSettingsSection("Agents");
      await $(`//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="${agentName}"]]`).click();
      await expect($('input[aria-label="Agent prompt file"]')).toHaveValue("~/.agents/prompts/system/default.md");
    } finally {
      await resetBackend();
      await nativeAgentConfiguration(originalConfig.agents);
      await resetApp();
    }
  });

  it("preserves desktop settings when agent configuration is rejected", async () => {
    const settings = { ...defaultSettings, defaultThinking: "high" };
    const capability = agentCapability();
    await mockBackend({
      ...connectedSessionResponses("agents-rollback"),
      load_app_settings: settings, save_app_settings: { settings }, start_pi: {}, stop_pi: false,
      "provider_auth:draft_catalog": catalogWith(capability.config),
      "pi_command:set_model": {},
      save_agent_definitions: { error: "Agent configuration was rejected" },
    });
    await emitPiEvent({ type: "session_switched" });
    await enableAgents(capability);
    await app.openSettings();
    await app.automaticRetryToggle.click();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent prompt file"]').setValue("rejected-change.md");
    await app.saveSettingsButton.click();

    await expect($(".settings-save [role='alert']")).toHaveText("Agent configuration was rejected");
    const calls = await backendCalls();
    const settingsWrites = calls.filter(({ command }) => command === "save_app_settings");
    expect(settingsWrites).toHaveLength(0);

    const configurations = calls.flatMap(({ command, args }) => command === "save_agent_definitions" ? [agentConfigSchema.parse(args.configuration)] : []);

    expect(configurations).toHaveLength(1);
    expect(configurations[0].agents.find((agent) => agent.name === "reviewer")?.path_agent_prompt).toBe("rejected-change.md");
  });
});

describe("Agent selection after app start", () => {
  beforeEach(async () => { await resetApp(); });
  afterEach(async () => {
    await browser.keys("Escape");
    await resetBackend();
  });

  it("lists and reloads the agents of a new conversation", async () => {
    await app.agentPicker.click();
    const reviewer = () => $('[role="listbox"][aria-label="Agent options"] [role="option"][data-value="reviewer"]');
    const menu = () => browser.execute(() => document.querySelector(".composer-picker-menu")?.textContent ?? "no menu");
    try { await reviewer().waitForDisplayed({ timeout: 5_000 }); }
    catch (cause) { throw new Error("Agent options are missing: " + await menu(), { cause }); }

    await $('button[aria-label="Reload agent definitions"]').click();
    await $('button[aria-label="Reload agent definitions"]').waitForEnabled();
    if (await $('.composer-picker-footer [role="alert"]').isExisting()) throw new Error("Agent reload failed: " + await menu());
    await expect(reviewer()).toBeDisplayed();
  });
});
