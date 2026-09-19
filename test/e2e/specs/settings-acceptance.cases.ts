import { $, $$, browser, expect } from "@wdio/globals";

import { join } from "node:path";

import type { AppSettings } from "../../../src/types.js";
import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, updateBackendResponse, resetApp, emitPiEvent, defaultSettings, enableAgents, connectedSessionResponses } from './acceptance-fixture.js';

describe("Settings acceptance", () => {
  before(async () => {
    await resetApp();
  });
  beforeEach(async () => {
    await app.openConversations();
  });

  it("saves the current configuration and confirms success", async () => {
    const [provider, ...modelParts] = defaultSettings.defaultModel.split("/");
    const model = { provider, id: modelParts.join("/"), name: "Configured model" };
    await mockBackend({
      ...connectedSessionResponses("settings-save"),
      load_app_settings: defaultSettings, save_app_settings: { settings: { ...defaultSettings, autoRetry: !defaultSettings.autoRetry } }, start_pi: {}, stop_pi: {},
      "pi_command:get_state": { ...connectedSessionResponses("settings-save")["pi_command:get_state"], model, thinkingLevel: defaultSettings.defaultThinking },
      "pi_command:get_available_models": { models: [model] },
      "pi_command:get_available_thinking_levels": { levels: [...new Set([defaultSettings.defaultThinking, "high", "off"])] },
      "pi_command:set_model": {},
      "pi_command:prompt": {},
    });
    await emitPiEvent({ type: "session_switched" });
    await enableAgents();
    try {
      await app.openSettings();
      await app.automaticRetryToggle.click();
      await app.saveSettingsButton.click();

      await expect(app.saveSettingsButton).toHaveText("Saved");
      await app.automaticRetryToggle.click();
      await updateBackendResponse("save_app_settings", { settings: defaultSettings });
      await app.saveSettingsButton.click();
      await expect(app.saveSettingsButton).toHaveText("Saved");
      const settingsWrites = (await backendCalls()).filter(({ command }) => command === "save_app_settings");
      expect(settingsWrites.map(({ args }) => (args.settings as AppSettings).autoRetry)).toEqual([!defaultSettings.autoRetry, defaultSettings.autoRetry]);
      expect(settingsWrites.every(({ mocked }) => mocked)).toBe(true);
      await app.openConversations();
    } finally {
      await resetApp();
    }
  });

  it("lets the user discover the main configuration areas and return to the conversation", async () => {
    await app.openSettings();
    await expect(app.saveSettingsButton).toHaveText("Save changes");

    for (const section of ["General", "Machines", "Keybinds", "Agents"]) {
      await app.openSettingsSection(section);
      await expect(app.settingsSectionHeading).toHaveText(section);
    }

    await app.openConversations();
    await expect(app.composer).toBeDisplayed();
  });

  it("keeps unsaved choices while the user reviews another settings area", async () => {
    await app.openSettings();
    const initialValue = await app.automaticRetryToggle.getAttribute("aria-checked");
    await app.automaticRetryToggle.click();
    const changedValue = initialValue === "true" ? "false" : "true";
    await expect(app.automaticRetryToggle).toHaveAttribute("aria-checked", changedValue);

    await app.openSettingsSection("Machines");
    await app.openSettingsSection("General");
    await expect(app.automaticRetryToggle).toHaveAttribute("aria-checked", changedValue);

    await app.automaticRetryToggle.click();
    await app.openConversations();
  });

  it("keeps an unsaved context-window cap while reviewing settings", async () => {
    await app.openSettings();
    await app.contextWindowCap.setValue("123000");
    await app.openSettingsSection("Agents");
    await app.openSettingsSection("General");

    await expect(app.contextWindowCap).toHaveValue("123000");
    await app.openConversations();
  });

  it("can prepare a remote machine without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Machines");
    const before = await $$("input[aria-label='Machine name']");
    await app.addMachineButton.click();
    const names = await $$("input[aria-label='Machine name']");
    const name = names[names.length - 1];

    await expect(names).toBeElementsArrayOfSize(before.length + 1);
    await expect(name).toHaveValue("New machine");
    await name.setValue("Acceptance machine");
    const card = await name.$('./ancestor::div[contains(@class, "mcp-card")]');
    const target = await card.$('input[placeholder="user@example.com"]');
    const executable = await card.$('input[placeholder="pi"]');
    await target.setValue("tester@example.com");
    await executable.setValue("/opt/pi/bin/pi");

    await expect(target).toHaveValue("tester@example.com");
    await expect(executable).toHaveValue("/opt/pi/bin/pi");
    await $('button[aria-label="Remove Acceptance machine"]').click();
    await expect($$("input[aria-label='Machine name']")).toBeElementsArrayOfSize(before.length);
    await app.openConversations();
  });

  it("can prepare an MCP server without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    const before = await $$("input[aria-label='Server name']");
    await app.addMcpServerButton.click();
    const names = await $$("input[aria-label='Server name']");
    const name = names[names.length - 1];

    await expect(names).toBeElementsArrayOfSize(before.length + 1);
    await name.setValue("Acceptance server");
    const card = await name.$('./ancestor::div[contains(@class, "mcp-card")]');
    const command = await card.$('.//label[span[normalize-space(.)="Command"]]/input');
    const args = await card.$('.//label[span[normalize-space(.)="Arguments"]]/input');
    await command.setValue("node");
    await args.setValue("server.js --quiet");

    await expect(card.$('.mcp-transport-toggle button[aria-pressed="true"]')).toHaveText("stdio");
    await expect(command).toHaveValue("node");
    await expect(args).toHaveValue("server.js --quiet");
    await $('button[aria-label="Remove Acceptance server"]').click();
    await expect($$("input[aria-label='Server name']")).toBeElementsArrayOfSize(before.length);
    await app.openConversations();
  });

  it("can prepare an HTTP MCP server with headers without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    const before = await $$('input[aria-label="Server name"]');
    await app.addMcpServerButton.click();
    const names = await $$('input[aria-label="Server name"]');
    const name = names[names.length - 1];
    await name.setValue("Acceptance HTTP");
    const card = await name.$('./ancestor::div[contains(@class, "mcp-card")]');
    await card.$('.//button[normalize-space(.)="HTTP"]').click();
    const url = await card.$('input[placeholder="https://example.com/mcp"]');
    const headers = await card.$('input[placeholder*="Authorization"]');
    await url.setValue("https://mcp.example.test/api");
    await headers.setValue('{"Authorization":"Bearer acceptance"}');

    await expect(card.$('.mcp-transport-toggle button[aria-pressed="true"]')).toHaveText("HTTP");
    await expect(url).toHaveValue("https://mcp.example.test/api");
    await expect(headers).toHaveValue('{"Authorization":"Bearer acceptance"}');
    await expect(card.$('.//label[span[normalize-space(.)="Command"]]')).not.toBeExisting();
    await $('button[aria-label="Remove Acceptance HTTP"]').click();
    await expect($$('input[aria-label="Server name"]')).toBeElementsArrayOfSize(before.length);
    await app.openConversations();
  });

  it("restores the documented default keybindings without saving them", async () => {
    await app.openSettings();
    await app.openSettingsSection("Keybinds");
    const newConversation = $('input[aria-label="New conversation shortcut"]');
    await newConversation.click();
    await browser.keys(["Control", "Shift", "K"]);
    await expect(newConversation).toHaveValue("Ctrl+Shift+K");
    await app.restoreKeybindsButton.click();

    const defaults = [
      ["New conversation shortcut", "Ctrl+N"],
      ["Toggle conversations shortcut", "Ctrl+B"],
      ["Toggle terminal shortcut", "Ctrl+J"],
      ["Focus composer shortcut", "Ctrl+E"],
      ["Open settings shortcut", "Ctrl+,"],
    ];
    for (const [label, shortcut] of defaults) {
      await expect($(`input[aria-label="${label}"]`)).toHaveValue(shortcut);
    }
    await app.openConversations();
  });

  it("unassigns a keybinding and can restore it without saving", async () => {
    await app.openSettings();
    await app.openSettingsSection("Keybinds");
    const shortcut = $('input[aria-label="New conversation shortcut"]');
    await shortcut.click();
    await browser.keys("Delete");
    await expect(shortcut).toHaveValue("");
    await app.restoreKeybindsButton.click();
    await expect(shortcut).toHaveValue("Ctrl+N");
    await app.openConversations();
  });

  it("offers agent settings without obsolete global Tools and Skills pages", async () => {
    await app.openSettings();
    await expect($('//*[contains(@class,"settings-nav")]//button[normalize-space(.)="Tools"]')).not.toBeExisting();
    await expect($('//*[contains(@class,"settings-nav")]//button[normalize-space(.)="Skills"]')).not.toBeExisting();
    await app.openSettingsSection("Agents");
    await expect(app.settingsSectionHeading).toHaveText("Agents");
    await app.openConversations();
  });
});
