import { $, browser, expect } from "@wdio/globals";
import { randomUUID } from "node:crypto";

import { agentConfigSchema } from "../../../clients/ui/lib/agentSchemas.js";
import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, defaultSettings, acceptanceAgents, enableAgents, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

const agentCapability = () => {
  const capability = acceptanceAgents();
  capability.config.revision = "acceptance-agent-revision";
  capability.config.agents.find(agent => agent.name === "general")!.tools = ["read", "bash"];
  return capability;
};

// Use a real temporary native runtime to read or restore configuration through the extension RPC.
async function nativeAgentConfiguration(agents?: ReturnType<typeof agentConfigSchema.parse>["agents"]) {
  const runtimeId = `e2e-agent-config-${randomUUID()}`;
  const result = await browser.execute(async (id, replacement) => {
    const invoke = (command: string, args: Record<string, unknown>) => window.__TAURI_INTERNALS__.invoke("daemon_invoke", { command, args: { ...args, clientId: "desktop:e2e-agent-profiles" } });
    try {
      try {
      await invoke("start_pi", { runtimeId: id, cwd: "~" });
      const config = await invoke("pi_command", { runtimeId: id, command: { type: "get_agent_configuration" } });
      if (replacement) {
        await invoke("pi_command", { runtimeId: id, command: { type: "configure_agents", configuration: { ...(config as Record<string, unknown>), agents: replacement } } });
        return { value: await invoke("pi_command", { runtimeId: id, command: { type: "get_agent_configuration" } }) };
      }
      return { value: config };
      } finally { await invoke("stop_pi", { runtimeId: id }); }
    } catch (error) { return { error: String(error) }; }
  }, runtimeId, agents ?? null);
  if ("error" in result) throw new Error("Native agent configuration failed: " + result.error);
  return agentConfigSchema.parse(result.value);
}

describe("Agent profiles acceptance", () => {
  beforeEach(async () => {
    await resetApp();
    const settings = { ...defaultSettings, tools: ["read", "bash"].map(name => ({ name, description: name, source: "built-in" })) };
    await mockBackend({ ...connectedSessionResponses("agents"), load_app_settings: settings, "pi_command:get_agent_configuration": agentCapability().config });
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
    await startTemporaryConversation({ "pi_command:get_agent_configuration": agentCapability().config });
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
    await startTemporaryConversation({ "pi_command:get_agent_configuration": agentCapability().config });
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

  it("sends agent configuration and its revision through the settings writer", async () => {
    const settings = { ...defaultSettings, defaultThinking: "high" };
    await mockBackend({
      ...connectedSessionResponses("agents-save"),
      "pi_command:get_agent_configuration": agentCapability().config,
      "pi_command:set_model": {}, "pi_command:configure_agents": { revision: "saved-agent-revision" }, save_app_settings: { settings }, stop_pi: false, start_pi: {}, list_sessions: [], load_app_settings: settings,
    });
    await emitPiEvent({ type: "session_switched" });
    await enableAgents(agentCapability());
    await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/acceptance"));
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent prompt file"]').setValue("review-acceptance.md");

    await app.saveSettingsButton.click();
    await expect(app.saveSettingsButton).toHaveText("Saved");
    const command = (await backendCalls()).find(({ args }) => args.command?.type === "configure_agents")?.args.command;
    const saved = agentConfigSchema.parse(command?.configuration);
    expect(saved.revision).toBe("acceptance-agent-revision");
    expect(saved.agents.find((agent) => agent.name === "reviewer")?.path_agent_prompt).toBe("review-acceptance.md");
    expect((await backendCalls()).filter(({ command }) => command === "save_app_settings")).toHaveLength(1);
    expect((await backendCalls()).some(({ command }) => command === "stop_pi")).toBe(true);
  });

  it("persists a GUI-created agent through a real native save", async () => {
    await resetBackend();
    const originalConfig = await nativeAgentConfiguration();
    const agentName = `e2e-persisted-${randomUUID()}`;
    try {
      await app.refreshForReset();
      await app.waitUntilReady();
      await resetBackend();
      await app.openSettings();
      await app.openSettingsSection("Agents");
      // An early capability event enables Agents before the native reader loads the final revision.
      await browser.waitUntil(async () => {
        const calls = await backendCalls();
        const reader = calls.find(call => !call.mocked && call.command === "pi_command" && call.args.command?.type === "get_agent_configuration");
        return reader !== undefined && calls.some(call => !call.mocked && call.command === "stop_pi" && call.args.runtimeId === reader.args.runtimeId);
      }, { timeout: 30_000, timeoutMsg: "Settings reader did not finish loading the current agent revision" });
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
      expect(calls.some(({ command, mocked, args }) => command === "pi_command" && args.command?.type === "configure_agents" && !mocked)).toBe(true);
      expect(calls.some(({ command, mocked }) => command === "start_pi" && !mocked)).toBe(true);
      // A separate native reader verifies persistence after the GUI writer has closed.
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
      "pi_command:get_agent_configuration": capability.config,
      "pi_command:set_model": {},
      "pi_command:configure_agents": { error: "Agent configuration was rejected" },
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

    const configurations = calls.flatMap(({ args }) => {
      return args.command?.type === "configure_agents" ? [agentConfigSchema.parse(args.command.configuration)] : [];
    });

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
