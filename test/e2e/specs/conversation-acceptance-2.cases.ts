import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { isUserPrompt, mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

describe("Conversation acceptance", () => {
  before(async () => {
    await resetApp();
  });
  beforeEach(async () => {
    await app.openConversations();
    await app.clearMessage();
  });

  it("opens, adds, deletes, and closes an ephemeral terminal", async () => {
    await mockBackend({ start_terminal: {}, resize_terminal: {}, close_terminal: {} });

    try {
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeDisplayed();
      const before = await $$(".terminal-tab").length;
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(before + 1);

      await app.deleteTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(before);
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "close_terminal"));
      expect((await backendCalls()).find(({ command }) => command === "close_terminal")?.mocked).toBe(true);
      await app.closeTerminalButton.click();
      await expect(app.terminalPanel).not.toBeExisting();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
      await resetBackend();
    }
  });

  it("sends the composed prompt to piop and clears the accepted draft", async () => {
    await mockBackend({ "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:fork": {}, "pi_command:prompt": {} });

    try {
      await app.prepareMessage("Explain the failing build");
      await app.sendMessageButton.click();

      await expect(app.composer).toHaveValue("");
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      const prompt = (await backendCalls()).find(({ args }) => isUserPrompt(args.command));
      expect(prompt?.args.command).toEqual({ type: "prompt", message: "Explain the failing build" });
      expect(prompt?.mocked).toBe(true);
    } finally {
      await resetBackend();
    }
  });

  it("does not submit Shift+Enter and submits with Enter", async () => {
    await mockBackend({ "pi_command:prompt": {} });

    try {
      await app.prepareMessage("First line");
      await browser.execute(() => {
        const element = document.querySelector('textarea[aria-label="Message piop"]');

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
      });
      await expect(app.composer).toHaveValue("First line");
      expect((await backendCalls()).filter(({ args }) => isUserPrompt(args.command))).toHaveLength(0);
      await app.composer.setValue("First line\nSecond line");
      expect((await app.composer.getValue()).replaceAll("\r\n", "\n")).toBe("First line\nSecond line");

      await app.composer.setValue("Submit this with Enter");
      await browser.keys("Enter");
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      expect((await backendCalls()).find(({ args }) => isUserPrompt(args.command))?.args.command).toEqual({ type: "prompt", message: "Submit this with Enter" });
      await expect(app.composer).toHaveValue("");
    } finally {
      await resetBackend();
    }
  });

  it("discovers and selects a slash command supplied by piop", async () => {
    await mockBackend({ ...connectedSessionResponses("command-session"), "pi_command:get_commands": { commands: [{ name: "review", description: "Review the current changes", source: "extension", sourceInfo: { source: "acceptance" } }] } });

    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("/rev");
      const palette = $('[role="listbox"][aria-label="piop commands"]');
      await expect(palette).toBeDisplayed();
      await expect(palette).toHaveText(expect.stringContaining("/review"));
      await palette.$('[role="option"]').click();
      expect((await app.composer.getValue()).trimEnd()).toBe("/review");
    } finally {
      await app.clearMessage();
      await resetBackend();
    }
  });

  it("hides internal commands from the slash-command palette", async () => {
    await mockBackend({
      ...connectedSessionResponses("filtered-command-session"),
      "pi_command:get_commands": {
        commands: [
          { name: "review", description: "Visible review command", source: "extension", sourceInfo: { source: "acceptance" } },
          { name: "internal-inline", description: "Inline-only command", source: "extension", sourceInfo: { source: "inline" } },
        ]
      },
    });

    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("/");
      const palette = $('[role="listbox"][aria-label="piop commands"]');
      await expect(palette).toHaveText(expect.stringContaining("/review"));
      const text = await palette.getText();
      expect(text).not.toContain("internal-inline");
      expect(await palette.$$("[role=option] strong").map((option) => option.getText())).toEqual(["/branch-off", "/worktree", "/compact", "/review"]);
      await expect(palette).toHaveText(expect.stringContaining("/compact"));
    } finally {
      await app.clearMessage();
      await resetBackend();
    }
  });

  it("retries the latest aborted response without deleting its history", async () => {
    const history = {
      entries: [
        { type: "message", id: "retry-user", parentId: null, message: { role: "user", content: "Retry this acceptance request", timestamp: 1 } },
        { type: "message", id: "retry-assistant", parentId: "retry-user", message: { role: "assistant", content: "", stopReason: "aborted", errorMessage: "Request was aborted", timestamp: 2 } },
      ],
      leafId: "retry-assistant",
    };

    await mockBackend({
      ...connectedSessionResponses("retry-session"),
      "pi_command:get_state": { ...connectedSessionResponses("retry-session")["pi_command:get_state"], sessionFile: "/tmp/retry-session.jsonl" },
      "pi_command:get_entries": history,
      "pi_command:fork": {},
      "pi_command:prompt": {},
      delete_session: {},
      list_sessions: [],
    });

    try {
      await emitPiEvent({ type: "session_switched" });
      const retry = $('//div[@role="status"]//button[normalize-space(.)="Retry"]');
      await retry.waitForClickable();
      await retry.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      expect((await backendCalls()).filter(({ args }) => ["fork", "prompt"].includes(String(args.command?.type))).map(({ args }) => args.command)).toEqual([
        { type: "prompt", message: "Retry this acceptance request" },
      ]);
      expect((await backendCalls()).some(({ command }) => command === "delete_session")).toBe(false);
    } finally {
      await updateBackendResponse("pi_command:get_entries", { entries: [], leafId: null });
      await emitPiEvent({ type: "session_switched" });
      await $('//div[@role="status"]//button[normalize-space(.)="Retry"]').waitForExist({ reverse: true });
      await resetBackend();
    }
  });

  it("includes an attached text file in the submitted prompt", async () => {
    await mockBackend({ "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:fork": {}, "pi_command:prompt": {} });

    try {
      await browser.execute(() => {
        const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
        const transfer = new DataTransfer(); transfer.items.add(new File(["Acceptance fixture content."], "acceptance-note.txt", { type: "text/plain" }));
        composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining("acceptance-note.txt"));
      await app.prepareMessage("Summarize the attachment");
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      const prompt = (await backendCalls()).find(({ args }) => isUserPrompt(args.command));
      expect(prompt?.args.command).toEqual({ type: "prompt", message: "Summarize the attachment\n\n<file name=\"acceptance-note.txt\">\nAcceptance fixture content.\n</file>" });
      await expect($(".attachments")).not.toBeExisting();
    } finally {
      await resetBackend();
    }
  });

  it("escapes quotes in attached filenames before submitting them", async () => {
    await mockBackend({ "pi_command:prompt": {} });

    try {
      await browser.execute(() => {
        const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
        const transfer = new DataTransfer(); transfer.items.add(new File(["Quoted filename content"], 'report "draft".txt', { type: "text/plain" }));
        composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining('report "draft".txt'));
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      expect((await backendCalls()).find(({ args }) => isUserPrompt(args.command))?.args.command).toEqual({ type: "prompt", message: '<file name="report &quot;draft&quot;.txt">\nQuoted filename content\n</file>' });
    } finally {
      await resetBackend();
    }
  });

  it("limits a single composer to twelve attachments", async () => {
    await browser.execute(() => {
      const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
      const transfer = new DataTransfer();

      for (let index = 1; index <= 13; index += 1) transfer.items.add(new File([`fixture ${index}`], `fixture-${index}.txt`, { type: "text/plain", lastModified: index }));
      composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    });
    await expect($$(".attachments > span")).toBeElementsArrayOfSize(12);
    await expect($(".attachments")).toHaveText(expect.stringContaining("fixture-12.txt"));
    expect(await $(".attachments").getText()).not.toContain("fixture-13.txt");

    while ((await $$(".attachments button")).length) await $(".attachments button").click();
    await expect($(".attachments")).not.toBeExisting();
  });

  it("removes an attachment before it can be submitted", async () => {
    await browser.execute(() => {
      const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
      const transfer = new DataTransfer(); transfer.items.add(new File(["Do not send this fixture."], "discard-me.txt", { type: "text/plain" }));
      composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    });
    await expect($(".attachments")).toHaveText(expect.stringContaining("discard-me.txt"));

    await $('button[aria-label="Remove discard-me.txt"]').click();
    await expect($(".attachments")).not.toBeExisting();
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("rejects a text attachment larger than 200 KB", async () => {
    await browser.execute(() => {
      const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(200_001)], "too-large.txt", { type: "text/plain" }));
      composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    });

    await expect($(".upload-error")).toHaveText("too-large.txt is larger than 200 KB");
    await expect($(".attachments")).not.toBeExisting();
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("submits an attached image with its encoded payload", async () => {
    const model = { provider: "e2e", id: "vision", name: "Vision model", input: ["text", "image"] };
    await mockBackend({ ...connectedSessionResponses("image-session"), "pi_command:get_state": { ...connectedSessionResponses("image-session")["pi_command:get_state"], model }, "pi_command:get_available_models": { models: [model] }, "pi_command:fork": {}, "pi_command:prompt": {} });

    try {
      await emitPiEvent({ type: "session_switched" });
      await expect(app.modelPicker).toHaveAttribute("data-value", "e2e/vision");
      await browser.execute(() => {
        const composer = document.querySelector(".composer");

      if (!composer) throw new Error("Message composer was not found");
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
        composer.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining("pixel.png"));
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));
      const command = (await backendCalls()).find(({ args }) => isUserPrompt(args.command))?.args.command;

      if (!command) throw new Error("Image prompt was not recorded");
      expect(command.message).toBe("");
      expect(command.images).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png", name: "pixel.png" }]);
    } finally {
      await resetBackend();
    }
  });

  it("renders live assistant activity delivered through Tauri events", async () => {
    await startTemporaryConversation({});

    try {
      await emitPiEvent({ type: "agent_start" });
      await expect($(".stream-banner")).toHaveText(expect.stringContaining("piop is working"));
      await expect($('button[aria-label="Stop piop"]')).toBeDisplayed();

      await emitPiEvent({ type: "message_start", message: { id: "acceptance-stream", role: "assistant", content: "Streaming acceptance response" } });
      await expect($(".assistant-message")).toHaveText(expect.stringContaining("Streaming acceptance response"));
      await expect($(".stream-caret")).toBeDisplayed();

      await emitPiEvent({ type: "agent_end" });
      await expect($(".stream-banner")).not.toBeExisting();
    } finally {
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("assembles incremental assistant text and exposes the completed response actions", async () => {
    const finalHistory = {
      entries: [{ type: "message", id: "incremental-final", parentId: null, message: { role: "assistant", content: "Incremental answer", timestamp: 200 } }],
      leafId: "incremental-final",
    };

    await mockBackend({ ...connectedSessionResponses("incremental-session"), "pi_command:get_entries": finalHistory });

    try {
      await emitPiEvent({ type: "agent_start" });
      await emitPiEvent({ type: "message_start", message: { role: "assistant", content: "", timestamp: 100 } });
      await emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      await emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Incremental " } });
      await emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" } });
      await expect($('//article[contains(@class,"assistant-message")][contains(.,"Incremental answer")]')).toBeDisplayed();
      await expect($(".stream-caret")).toBeDisplayed();

      await emitPiEvent({ type: "message_end", message: { role: "assistant", content: "Incremental answer", timestamp: 200 } });
      await emitPiEvent({ type: "agent_end" });
      await expect($(".stream-caret")).not.toBeExisting();
      await expect($('//article[contains(@class,"assistant-message")][contains(.,"Incremental answer")]').$('button[aria-label^="Copy assistant response"]')).toBeEnabled();
    } finally {
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("shows a completed provider error without offering an aborted-response retry", async () => {
    const history = {
      entries: [
        { type: "message", id: "error-user", parentId: null, message: { role: "user", content: "Trigger the provider", timestamp: 1 } },
        { type: "message", id: "error-assistant", parentId: "error-user", message: { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider rejected the request", timestamp: 2 } },
      ],
      leafId: "error-assistant",
    };

    await mockBackend({ ...connectedSessionResponses("error-session"), "pi_command:get_entries": history });

    try {
      await emitPiEvent({ type: "session_switched" });
      const failure = $(".message-failure");
      await expect(failure).toHaveText("Response failed: Provider rejected the request");
      await expect(failure.$('button=Retry')).not.toBeExisting();
    } finally {
      await resetBackend();
    }
  });

  it("renders a tool call from running through completion", async () => {
    const enableDebug = $('button[aria-label="Enable debug mode"]');

    if (await enableDebug.isExisting()) await enableDebug.click();
    await expect($('button[aria-label="Disable debug mode"]')).toBeEnabled();
    await emitPiEvent({ type: "agent_start" });
    await emitPiEvent({ type: "tool_execution_start", toolCallId: "acceptance-tool", toolName: "acceptance_tool", args: { path: "README.md" } });
    const tool = $('//details[contains(@class,"tool-event")][.//strong[contains(.,"acceptance_tool")]]');
    await expect(tool).toHaveText(expect.stringContaining("Running…"));

    await emitPiEvent({ type: "tool_execution_update", toolCallId: "acceptance-tool", partialResult: { content: "Reading…" } });
    await emitPiEvent({ type: "tool_execution_end", toolCallId: "acceptance-tool", result: { content: "Tool finished" }, isError: false });
    await expect(tool).toHaveText(expect.stringContaining("Completed"));
    await updateBackendResponse("pi_command:get_tool_payload", { chunk: JSON.stringify({ content: "Tool finished" }), length: 0, revision: "tool" });
    await tool.$("summary").click();
    await expect(tool.$(".tool-output pre")).toHaveText("Tool finished");
    await emitPiEvent({ type: "agent_end" });
  });
});
