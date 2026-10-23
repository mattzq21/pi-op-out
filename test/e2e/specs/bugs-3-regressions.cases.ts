import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { failureState, mockBackend, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, enableAgents, connectedSessionResponses, startTemporaryConversation, withClientSettingsWriteFailure } from './acceptance-fixture.js';

describe("BUGS-3 regressions", () => {
  beforeEach(async () => {
    await resetApp();
    await app.openConversations();
    await app.clearMessage();
  });
  afterEach(async () => {
    if (await $(".error-toast").isExisting()) await $(".error-toast button").click();

    if (await app.terminalPanel.isDisplayed()) await app.closeTerminalButton.click();
    await app.conversationSearch.clearValue();
    await resetBackend();
  });

  it("keeps a failed rename available for retry", async () => {
    const indexed = { id: "bugs3-rename", path: "/tmp/bugs3-rename.jsonl", name: "Rename target", project: "BUGS-3", cwd: "/tmp", preview: "Rename", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], ...connectedSessionResponses(indexed.id), "pi_command:set_session_name": { error: "Rename failed" } });
    await emitPiEvent({ type: "session_switched" });
    await app.conversationSearch.setValue(indexed.name);
    await browser.execute(() => {
      const item = document.querySelector(".session-item");

      if (!item) throw new Error("Conversation item was not found");
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
    });
    await $('//div[@role="menu"]//button[normalize-space(.)="Rename conversation"]').click();

    const input = $('input[aria-label="Rename conversation"]');
    await input.setValue("Name to retry");
    await $('//dialog//button[normalize-space(.)="Continue"]').click();

    await expect(input).toHaveValue("Name to retry");
    await expect($(".dialog-error")).toHaveText("Rename failed");
    await $('//dialog//button[normalize-space(.)="Cancel"]').click();
  });

  it("isolates drafts and terminals between fresh conversations", async () => {
    const first = await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {} });

    try {
      await app.prepareMessage("First fresh draft");
      await app.openTerminalButton.click();
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);

      const second = await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {} });
      expect(second.sessionId).not.toBe(first.sessionId);

      await expect(app.composer).toHaveValue("");
      await expect(app.terminalPanel).not.toBeDisplayed();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(1);
    } catch (cause) {
      throw new Error(String(cause) + " " + await failureState(), { cause });
    } finally {
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("keeps a terminal tab when closing its process fails", async () => {
    await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {}, "shared_terminal:close": { error: "Terminal close failed" } });

    try {
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeExisting();
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);

      await app.deleteTerminalButton.click();

      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);
      await expect($(".error-toast strong")).toHaveText("Could not close terminal");
      await expect($(".error-toast span")).toHaveText("Terminal close failed");
    } catch (cause) {
      throw new Error(String(cause) + " " + await failureState(), { cause });
    } finally {
      await resetApp();
    }
  });

  it("reports a failed agent selection", async () => {
    await startTemporaryConversation({});
    await enableAgents();
    await updateBackendResponse("pi_command:select_agent", { error: "Agent switch failed" });
    await $('button[aria-label="Agent"]').click();
    await $('//div[@role="listbox" and @aria-label="Agent options"]//button[.//span[normalize-space(.)="reviewer"]]').click();

    await expect($('button[aria-label="Agent"]')).toHaveAttribute("data-value", "general");
    await expect($(".error-toast strong")).toHaveText("Could not change agent");
    await expect($(".error-toast span")).toHaveText("Agent switch failed");
  });

  it("does not enable debug mode when persistence fails", async () => {
    const toggle = $('button[aria-label="Enable debug mode"], button[aria-label="Disable debug mode"]');
    const initialLabel = await toggle.getAttribute("aria-label");

    if (!initialLabel) throw new Error("Debug toggle has no accessible label");
    await withClientSettingsWriteFailure(async () => {
      await toggle.click();
      await expect($(".error-toast strong")).toHaveText("Could not change debug mode");
      await expect(toggle).toHaveAttribute("aria-label", initialLabel);
      await expect($(".error-toast span")).toHaveText(expect.stringMatching(/directory|denied|exists/i));
    });
  });
});
