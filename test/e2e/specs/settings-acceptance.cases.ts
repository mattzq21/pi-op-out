import { $, $$, browser, expect } from "@wdio/globals";

import { appSettingsSchema } from "../../../clients/ui/lib/responseSchemas.js";
import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, updateBackendResponse, resetApp, emitPiEvent, defaultSettings, enableAgents, connectedSessionResponses } from './acceptance-fixture.js';

describe("Settings acceptance", () => {
  beforeEach(async () => {
    await resetApp();
    await mockBackend({ ...connectedSessionResponses("settings-reader"), load_app_settings: defaultSettings });
    await app.openConversations();
  });

  it("saves the current configuration and confirms success", async () => {
    const model = { provider: "e2e", id: "acceptance", name: "Configured model", reasoning: true };
    await mockBackend({
      ...connectedSessionResponses("settings-save"),
      load_app_settings: defaultSettings, save_app_settings: { settings: { ...defaultSettings, autoRetry: !defaultSettings.autoRetry } }, start_pi: {}, stop_pi: false,
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
      await updateBackendResponse("load_app_settings", { ...defaultSettings, autoRetry: !defaultSettings.autoRetry });
      await app.automaticRetryToggle.click();
      await updateBackendResponse("save_app_settings", { settings: defaultSettings });
      await app.saveSettingsButton.click();
      await expect(app.saveSettingsButton).toHaveText("Saved");
      const settingsWrites = (await backendCalls()).filter(({ command }) => command === "save_app_settings");
      expect(settingsWrites.map(({ args }) => appSettingsSchema.parse(args.settings).autoRetry)).toEqual([!defaultSettings.autoRetry, defaultSettings.autoRetry]);
      expect(settingsWrites.every(({ mocked }) => mocked)).toBe(true);
      await app.openConversations();
    } finally {
      await resetApp();
    }
  });

  it("lets the user discover the main configuration areas and return to the conversation", async () => {
    await app.openSettings();
    await expect(app.saveSettingsButton).toHaveText("Save changes");

    for (const section of ["General", "Hosts", "Keybinds", "Agents"]) {
      if (section === "Agents") await $('//nav[contains(@class,"settings-nav")]//button[normalize-space(.)="Local"]').click();
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

    await app.openSettingsSection("Hosts");
    await app.openSettingsSection("General");
    await expect(app.automaticRetryToggle).toHaveAttribute("aria-checked", changedValue);

    await app.automaticRetryToggle.click();
    await app.openConversations();
  });

  it("keeps an unsaved context-window cap while reviewing settings", async () => {
    await app.openSettings();
    const capEnabled = $('[role="switch"][aria-label="Enable context window cap"]');
    if (await capEnabled.getAttribute("aria-checked") !== "true") await capEnabled.click();
    await expect(app.contextWindowCap).toBeEnabled();
    await app.contextWindowCap.setValue("123000");
    await app.openSettingsSection("Agents");
    await app.openSettingsSection("General");

    await expect(app.contextWindowCap).toHaveValue("123000");
    await app.openConversations();
  });

  it("can prepare a remote machine without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Hosts");
    const before = await $$("input[aria-label='Host name']").length;
    await app.addHostButton.click();
    const names = await $$("input[aria-label='Host name']");
    const name = names[(await names.length) - 1];

    await expect(names).toBeElementsArrayOfSize(before + 1);
    await expect(name).toHaveValue("New host");
    await name.setValue("Acceptance machine");
    const card = await name.$('./ancestor::div[contains(@class, "mcp-card")]');
    const target = await card.$('input[placeholder="user@example.com"]');
    const executable = await card.$('input[aria-label$="Piop daemon executable"]');
    await target.setValue("tester@example.com");
    // Apply the whole edit in one input event; the field normalizes legacy /pi paths while typing.
    await browser.execute(() => {
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Acceptance machine Piop daemon executable"]');
      if (!field) throw new Error("Machine executable input is missing");
      field.value = "/opt/pi/bin/piopd";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect(target).toHaveValue("tester@example.com");
    await expect(executable).toHaveValue("/opt/pi/bin/piopd");
    await $('button[aria-label="Remove Acceptance machine"]').click();
    await $('//dialog//button[normalize-space(.)="Remove host"]').click();
    await expect($$("input[aria-label='Host name']")).toBeElementsArrayOfSize(before);
    await app.openConversations();
  });


  it("can prepare an MCP server without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('button[aria-label="Edit MCP servers as JSON"]').click();
    const editor = $('textarea[aria-label="MCP server configuration"]');
    const original = await editor.getValue();
    const servers = { acceptance: { command: "node", args: ["server.js", "--quiet"] } };
    await editor.setValue(JSON.stringify(servers));

    await app.openSettingsSection("General");
    await app.openSettingsSection("Agents");
    if (!await editor.isExisting()) await $('button[aria-label="Edit MCP servers as JSON"]').click();
    expect(JSON.parse(await editor.getValue())).toEqual(servers);
    await expect($(".mcp-error")).not.toBeExisting();
    await editor.setValue(original);
    await app.openConversations();
  });


  it("can prepare an HTTP MCP server with headers without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('button[aria-label="Edit MCP servers as JSON"]').click();
    const editor = $('textarea[aria-label="MCP server configuration"]');
    const original = await editor.getValue();
    const servers = { acceptance: { url: "https://mcp.example.test/api", headers: { Authorization: "Bearer acceptance" } } };
    await editor.setValue(JSON.stringify(servers));

    if (!await editor.isExisting()) await $('button[aria-label="Edit MCP servers as JSON"]').click();
    expect(JSON.parse(await editor.getValue())).toEqual(servers);
    await expect($(".mcp-error")).not.toBeExisting();
    await editor.setValue('{"acceptance":{"url":"file:///tmp/server"}}');
    await expect($(".mcp-error")).toBeDisplayed();
    await expect(app.saveSettingsButton).toBeDisabled();
    await editor.setValue(original);
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
