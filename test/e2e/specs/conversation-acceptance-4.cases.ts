import { $, $$, browser, expect } from "@wdio/globals";

import { randomUUID } from "node:crypto";

import { app } from "../pageobjects/app.page.js";
import { mockBackend, connectedSessionResponses, isUserPrompt, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, pressShortcut, startTemporaryConversation, withClientSettingsWriteFailure } from './acceptance-fixture.js';

describe("Conversation acceptance", () => {
  beforeEach(async () => {
    await resetApp();
    await app.openConversations();
    await app.clearMessage();
  });

  it("returns multiline extension editor content", async () => {
    await startTemporaryConversation({ "pi_command:extension_ui_response": {} });

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor-content", method: "editor", title: "Release notes", placeholder: "Release notes", prefill: "Initial line" });
      const editor = $('textarea[aria-label="Release notes"]');
      await editor.setValue("First line");
      await browser.keys("Enter");
      await browser.keys("Second line");
      await expect(editor).toHaveValue("First line\nSecond line");
      await $('//dialog//button[normalize-space(.)="Continue"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "acceptance-editor-content"));
      expect((await backendCalls()).find(({ args }) => args.command?.id === "acceptance-editor-content")?.args.command).toMatchObject({ type: "extension_ui_response", id: "acceptance-editor-content", value: "First line\nSecond line" });
    } finally {
      await resetBackend();
    }
  });

  it("supports extension selection, confirmation, and cancellation", async () => {
    await startTemporaryConversation({ "pi_command:extension_ui_response": {} });

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-select", method: "select", title: "Choose a target", options: ["Alpha", "Beta"] });
      await $('//dialog//button[normalize-space(.)="Beta"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").length === 1);
      await expect(app.extensionDialogHeading).not.toBeExisting();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-confirm", method: "confirm", title: "Deploy now?", message: "This will deploy the acceptance build." });
      await expect(app.extensionDialogHeading).toHaveText("Deploy now?");
      await $('//dialog//button[normalize-space(.)="Confirm"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").length === 2);
      await expect(app.extensionDialogHeading).not.toBeExisting();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor", method: "editor", title: "Edit release notes", prefill: "Initial notes" });
      await expect($('textarea[aria-label="Edit release notes"]')).toHaveValue("Initial notes");
      await $('//dialog//button[normalize-space(.)="Cancel"]').click();

      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").length === 3);
      expect((await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").map(({ args }) => args.command)).toMatchObject([
        { type: "extension_ui_response", id: "acceptance-select", value: "Beta" },
        { type: "extension_ui_response", id: "acceptance-confirm", confirmed: true },
        { type: "extension_ui_response", id: "acceptance-editor", cancelled: true },
      ]);
    } finally {
      await resetBackend();
    }
  });

  it("shows and clears extension status, widgets, and notifications", async () => {
    await startTemporaryConversation({});
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-status", method: "setStatus", statusKey: "pi-desktop-mcp-loading", statusText: "Indexing workspace" });
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-widget", method: "setWidget", widgetKey: "acceptance", widgetLines: ["3 files changed", "Tests pending"] });
    await expect($(".mcp-loading-list")).toBeDisplayed();
    await expect($(".extension-widget > div:nth-child(1)")).toHaveText("3 files changed");
    await expect($(".extension-widget > div:nth-child(2)")).toHaveText("Tests pending");

    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-notice", method: "notify", notifyType: "warning", message: "Review generated changes" });
    await expect($(".error-toast strong")).toHaveText("Extension warning");
    await expect($(".error-toast span")).toHaveText("Review generated changes");
    await $(".error-toast button").click();

    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-status-clear", method: "setStatus", statusKey: "pi-desktop-mcp-loading", statusText: "" });
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-widget-clear", method: "setWidget", widgetKey: "acceptance" });
    await expect($(".mcp-loading-list")).not.toBeExisting();
    await expect($(".extension-widget")).not.toBeExisting();
  });

  it("surfaces actionable extension errors but ignores stale-context noise", async () => {
    await startTemporaryConversation({});
    await emitPiEvent({ type: "extension_error", error: "This extension ctx is stale after session replacement or reload. request ignored" });
    await expect($(".error-toast")).not.toBeExisting();

    await emitPiEvent({ type: "extension_error", error: "Acceptance extension failed to load" });
    await expect($(".error-toast strong")).toHaveText("Extension error");
    await expect($(".error-toast span")).toHaveText("Acceptance extension failed to load");
    await $(".error-toast button").click();
    await expect($(".error-toast")).not.toBeExisting();
  });

  it("applies extension-driven window titles and editor text", async () => {
    await startTemporaryConversation({});
    const originalTitle = await browser.getTitle();

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-title", method: "setTitle", title: "Acceptance review in progress" });
      await browser.waitUntil(async () => await browser.getTitle() === "Acceptance review in progress");
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor-text", method: "set_editor_text", text: "Review the generated acceptance changes" });
      await expect(app.composer).toHaveValue("Review the generated acceptance changes");
      expect(await browser.execute(() => document.activeElement?.getAttribute("aria-label"))).toBe("Message piop");
    } finally {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-title-reset", method: "setTitle", title: originalTitle });
      await app.clearMessage();
    }
  });

  it("stacks simultaneous application and extension notices", async () => {
    await startTemporaryConversation({});
    const debug = $('button[aria-label$="debug mode"]');

    try {
      await withClientSettingsWriteFailure(async () => {
        await debug.click();
        await expect($(".error-toast strong")).toHaveText("Could not change debug mode");
      });
      await emitPiEvent({ type: "extension_ui_request", id: "stacked-notice", method: "notify", notifyType: "warning", message: "Review generated changes" });
      await expect($$(".error-toast")).toBeElementsArrayOfSize(2);
      const toasts = await $$(".error-toast");
      expect(await toasts[0].getLocation("y")).not.toBe(await toasts[1].getLocation("y"));
    } finally {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("queues extension dialogs behind the project picker", async () => {
    const sessionId = randomUUID();
    await mockBackend({ ...connectedSessionResponses(sessionId), home_directory: "/tmp",
      list_sessions: [{ id: sessionId, path: `/tmp/${sessionId}.jsonl`, cwd: "/tmp", name: "Empty extension session", project: "tmp", preview: "", messageCount: 0 }],
    });

    try {
      await app.conversationSearch.setValue("Empty extension session");
      await $('.session-main[aria-label^="Empty extension session,"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(call => call.command === "start_pi" && call.mocked));
      await app.openProjectChooser();
      await emitPiEvent({ type: "extension_ui_request", id: "queued-confirm", method: "confirm", title: "Confirm extension action" });
      await expect($$("dialog[open]")).toBeElementsArrayOfSize(1);
      await expect(app.projectDialogHeading).toBeDisplayed();
      await app.cancelProjectChooser();
      await expect(app.extensionDialogHeading).toHaveText("Confirm extension action");
      await $('//dialog//button[normalize-space(.)="Cancel"]').click();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectChooser();

      if (await app.extensionDialogHeading.isExisting()) await $('//dialog//button[normalize-space(.)="Cancel"]').click();
      await resetApp();
    }
  });

  it("keeps extension input when sending its response fails", async () => {
    await startTemporaryConversation({ "pi_command:extension_ui_response": { error: "Extension response channel closed" } });

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "failed-response", method: "input", title: "Required value", placeholder: "Label" });
      const input = $('input[aria-label="Label"]');
      await input.setValue("release-candidate");
      await $('//dialog//button[normalize-space(.)="Continue"]').click();
      await expect($(".dialog-error")).toHaveText("Extension response channel closed");
      await expect(input).toHaveValue("release-candidate");
    } finally {
      if (await app.extensionDialogHeading.isExisting()) {
        await updateBackendResponse("pi_command:extension_ui_response", {});
        await $('//dialog//button[normalize-space(.)="Continue"]').click();
      }

      await resetBackend();
    }
  });

  it("uses Tab to complete the selected slash command without submitting", async () => {
    await startTemporaryConversation({ "pi_command:prompt": {} });

    try {
      await emitPiEvent({ type: "session_switched" });
      const promptsBeforeCompletion = (await backendCalls()).filter(({ args }) => isUserPrompt(args.command)).length;
      await app.prepareMessage("/comp");
      await expect($('[role="option"][aria-selected="true"]')).toHaveText(expect.stringContaining("/compact"));
      await browser.keys("Tab");
      expect((await app.composer.getValue()).trim()).toBe("/compact");
      expect((await backendCalls()).filter(({ args }) => isUserPrompt(args.command))).toHaveLength(promptsBeforeCompletion);
    } finally {
      await app.clearMessage();
      await resetBackend();
    }
  });

  it("ignores global layout shortcuts while a modal is open", async () => {
    await app.openSettings();
    await app.openSettingsSection("Keybinds");
    const panelShortcut = await $('input[aria-label="Toggle conversations shortcut"]').getValue();
    await app.openConversations();
    await $('button[aria-label="New conversation"]').click();
    await app.openProjectChooser();

    try {
      await pressShortcut(panelShortcut);
      await expect($(".session-panel")).toBeDisplayed();
      await expect(app.projectDialogHeading).toBeDisplayed();
    } finally {
      if (!(await $(".session-panel").isExisting())) await pressShortcut(panelShortcut);
      await app.cancelProjectChooser();
    }
  });
});
