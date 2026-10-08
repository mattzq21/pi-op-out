import { $, browser, expect } from "@wdio/globals";
import { readFileSync, writeFileSync } from "node:fs";

import { agentConfigSchema } from "../../../clients/ui/lib/agentSchemas.js";
import { app } from "../pageobjects/app.page.js";
import { installedAgentConfigPath, mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, defaultSettings, acceptanceAgents, enableAgents, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

describe("Agent profiles acceptance", () => {
  before(async () => {
    await resetApp();
  });
  beforeEach(async () => {
    await app.openConversations();
    await mockBackend({ ...connectedSessionResponses("agents"), load_app_settings: defaultSettings });
    await enableAgents();
  });
  afterEach(async () => {
    if (await app.settingsHeading.isExisting()) await app.openConversations();
    await resetBackend();
  });

  it("reveals agent controls when the extension advertises them", async () => {
    await startTemporaryConversation({});
    await enableAgents();
    await expect(app.agentPicker).toHaveText("general");
    await app.agentPicker.click();
    const agents = $('[role="listbox"][aria-label="Agent options"]');
    await expect(agents).toHaveText(expect.stringContaining("reviewer"));
    await browser.keys("Escape");

    await app.openSettings();
    await expect(app.settingsSection("Agents")).toBeDisplayed();
  });

  it("selects an agent through the agent RPC", async () => {
    await mockBackend({ "pi_command:select_agent": {} });
    await app.chooseComposerOption("Agent", "reviewer");

    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.type === "select_agent"));
    expect((await backendCalls()).find(({ args }) => args.command?.type === "select_agent")?.args.command).toMatchObject({ type: "select_agent", agent: "reviewer" });
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

  it("saves agent configuration using a sessionless writer", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" };
    await mockBackend({
      ...connectedSessionResponses("agents-save"),
      "pi_command:set_model": {}, "pi_command:configure_agents": {}, save_app_settings: { settings }, stop_pi: false, start_pi: {}, list_sessions: [], load_app_settings: settings,
    });
    await emitPiEvent({ type: "session_switched" });
    await enableAgents();
    await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/acceptance"));
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent prompt file"]').setValue("review-acceptance.md");

    await app.saveSettingsButton.click();
    await expect(app.saveSettingsButton).toHaveText("Saved");
    const command = (await backendCalls()).find(({ args }) => args.command?.type === "configure_agents")?.args.command;
    const saved = agentConfigSchema.parse(command?.configuration);
    expect(saved.agents.find((agent) => agent.name === "reviewer")?.path_agentprompt).toBe("review-acceptance.md");
    expect((await backendCalls()).filter(({ command }) => command === "save_app_settings")).toHaveLength(1);
    expect((await backendCalls()).some(({ command }) => command === "stop_pi")).toBe(true);
    expect((await backendCalls()).some(({ command, args }) => command === "start_pi" && args.noSession === true)).toBe(true);
  });

  it("persists a GUI-created agent through a real native save", async () => {
    const originalConfig = readFileSync(installedAgentConfigPath);
    const agentName = "e2e-persisted-agent";

    try {
      writeFileSync(installedAgentConfigPath, JSON.stringify(acceptanceAgents().config, null, 2));
      await resetBackend();
      await browser.execute(async settings => {
        const tauri = window.__TAURI_INTERNALS__;
        await tauri.invoke("daemon_invoke", { command: "save_app_settings", args: { settings, clientId: "desktop:e2e-settings" } });
      }, defaultSettings);
      await app.refreshForReset();
      await app.waitUntilReady();
      await resetBackend();
      await app.openSettings();
      await app.settingsSection("Agents").waitForDisplayed();
      await app.openSettingsSection("Keybinds");
      await app.restoreKeybindsButton.click();
      await app.openSettingsSection("Agents");
      await $('//button[normalize-space(.)="Add agent"]').click();
      await $('input[aria-label="Agent name"]').setValue(agentName);
      await $('input[aria-label="Agent prompt file"]').setValue("sysprompt/default.md");
      await $('input[aria-label="System prompt file"]').setValue("sysprompt/default.md");
      await expect(app.saveSettingsButton).toBeClickable();
      await app.saveSettingsButton.click();

      await browser.waitUntil(async () => {
        const error = $('.settings-save [role="alert"]');

        if (await error.isExisting()) throw new Error(await error.getText());
        const saved = agentConfigSchema.parse(JSON.parse(readFileSync(installedAgentConfigPath, "utf8")));

        return saved.agents.some((agent) => agent.name === agentName);
      }, { timeout: 30_000, timeoutMsg: "The GUI-created agent was not written to the installed agent config" });
      await expect(app.saveSettingsButton).toHaveText("Saved");
      const saved = agentConfigSchema.parse(JSON.parse(readFileSync(installedAgentConfigPath, "utf8")));
      expect(saved.agents.find((agent) => agent.name === agentName)).toMatchObject({
        path_agentprompt: "sysprompt/default.md",
        path_systemprompt: "sysprompt/default.md",
      });
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args, mocked }) => command === "start_pi" && args.noSession === true && !mocked), { timeoutMsg: "Saving the agent did not start a sessionless native writer" });

      await app.openConversations();
      await app.agentPicker.click();
      await expect($('[role="listbox"][aria-label="Agent options"]')).toHaveText(expect.stringContaining(agentName));
      await browser.keys("Escape");
      await app.openSettings();
      await app.openSettingsSection("Agents");
      await $(`//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="${agentName}"]]`).click();
      await expect($('input[aria-label="Agent prompt file"]')).toHaveValue("sysprompt/default.md");
    } finally {
      writeFileSync(installedAgentConfigPath, originalConfig);
      await resetApp();
    }
  });

  it("preserves desktop settings when agent configuration is rejected", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" };
    const capability = acceptanceAgents();
    await mockBackend({
      ...connectedSessionResponses("agents-rollback"),
      load_app_settings: settings, save_app_settings: { settings }, start_pi: {}, stop_pi: false,
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
    expect(configurations[0].agents.find((agent) => agent.name === "reviewer")?.path_agentprompt).toBe("rejected-change.md");
  });
});
