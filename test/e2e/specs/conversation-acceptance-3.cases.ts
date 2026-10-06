import { $, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

describe("Conversation acceptance", () => {
  before(async () => {
    await resetApp();
  });
  beforeEach(async () => {
    await app.openConversations();
    await app.clearMessage();
  });

  it("renders a failed tool with its diagnostic output", async () => {
    await startTemporaryConversation({ load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high", debugMode: true } });
    await emitPiEvent({ type: "session_switched" });
    const enableDebug = $('button[aria-label="Enable debug mode"]');

    if (await enableDebug.isExisting()) await enableDebug.click();
    await expect($('button[aria-label="Disable debug mode"]')).toBeEnabled();
    await emitPiEvent({ type: "agent_start" });
    await emitPiEvent({ type: "tool_execution_start", toolCallId: "acceptance-failed-tool", toolName: "write", args: { path: "protected.txt" } });
    await emitPiEvent({ type: "tool_execution_end", toolCallId: "acceptance-failed-tool", result: { content: "Permission denied" }, isError: true });

    const tool = $('//details[contains(@class,"tool-event")][.//strong[contains(.,"write")]]');
    await expect(tool).toHaveText(expect.stringContaining("Failed"));
    await updateBackendResponse("pi_command:get_tool_payload", { chunk: JSON.stringify({ content: "Permission denied" }), length: 0, revision: "tool" });
    await tool.$("summary").click();
    await expect(tool.$(".tool-output pre")).toHaveText("Permission denied");
    await emitPiEvent({ type: "agent_end" });
  });

  it("tracks queued steering and follow-up messages from backend events", async () => {
    await startTemporaryConversation({});

    try {
      await emitPiEvent({ type: "agent_start" });
      await emitPiEvent({ type: "queue_update", steering: ["First correction", "Second correction"], followUp: ["Next task"], pendingMessages: [{ id: "steer-1", message: "First correction", behavior: "steer" }, { id: "steer-2", message: "Second correction", behavior: "steer" }, { id: "follow-1", message: "Next task", behavior: "followUp" }] });
      await expect($$(".pending-message")).toBeElementsArrayOfSize(3);

      await emitPiEvent({ type: "queue_update", steering: [], followUp: [], pendingMessages: [] });
      await expect($(".pending-messages")).not.toBeExisting();
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [], pendingMessages: [] });
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("updates the thinking selector when piop changes effort", async () => {
    await resetApp();
    await mockBackend(connectedSessionResponses("thinking-event-session"));

    try {
      await emitPiEvent({ type: "session_switched" });
      await expect(app.thinkingLevelPicker).toHaveText("High");
      await emitPiEvent({ type: "thinking_level_changed", level: "off" });
      await expect(app.thinkingLevelPicker).toHaveText("Off");
    } finally {
      await resetBackend();
    }
  });

  it("shows estimated context usage after compaction", async () => {
    await mockBackend({
      ...connectedSessionResponses("context-session"),
      "pi_command:get_session_stats": { contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: null } },
    });

    try {
      await emitPiEvent({ type: "session_switched" });
      const wheel = $(".context-wheel");
      await expect(wheel).toBeDisplayed();
      expect((await wheel.getAttribute("aria-label"))?.replaceAll(",", "")).toBe("42% of 100000 context tokens used");

      await updateBackendResponse("pi_command:get_session_stats", { contextUsage: { tokens: 18_000, contextWindow: 100_000, percent: 18 } });
      await emitPiEvent({ type: "compaction_end", result: { estimatedTokensAfter: 18_000 } });
      await browser.waitUntil(async () => (await wheel.getAttribute("aria-label"))?.startsWith("18%") === true);
      expect((await wheel.getAttribute("aria-label"))?.replaceAll(",", "")).toBe("18% of 100000 context tokens used");
    } finally {
      await resetBackend();
    }
  });

  it("shows cache reuse for both a response and the whole session", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high", debugMode: true };

    const history = {
      entries: [
        { type: "message", id: "cache-user", parentId: null, message: { role: "user", content: "Reuse the cached context", timestamp: 1 } },
        { type: "message", id: "cache-assistant", parentId: "cache-user", message: { role: "assistant", content: "The cached context was reused.", timestamp: 2, usage: { input: 1_000, output: 20, cacheRead: 3_000, cacheWrite: 0, totalTokens: 4_020 } } },
      ],
      leafId: "cache-assistant",
    };

    await mockBackend({ ...connectedSessionResponses("cache-session"), "pi_command:get_entries": history, load_app_settings: settings });

    try {
      await emitPiEvent({ type: "session_switched" });
      const enableDebug = $('button[aria-label="Enable debug mode"]');

      if (await enableDebug.isExisting()) await enableDebug.click();
      await expect($(".cache-hit-rate")).toHaveAttribute("aria-label", "Cache 75%, 3000/4000");
      await expect($(".session-cache-hit")).toHaveText("75%");
    } finally {
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("renders terminal output and reports when the process exits", async () => {
    await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {}, "shared_terminal:close": {} });

    try {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args }) => command === "shared_terminal" && args.action === "start"));
      const terminalId = (await backendCalls()).find(({ command, args }) => command === "shared_terminal" && args.action === "start")?.args.sharedTerminalId;

      if (!terminalId) throw new Error("Terminal start was not recorded");

      await emitPiEvent({ type: "terminal_output", terminalId, hostId: "local", sessionId: "acceptance-terminal", generation: "e2e", outputEnd: "acceptance terminal output\r\n".length, data: "acceptance terminal output\r\n" });
      await browser.waitUntil(async () => String(await browser.execute(() => document.querySelector(".xterm-rows")?.textContent)).includes("acceptance terminal output"));
      await emitPiEvent({ type: "terminal_exit", terminalId, hostId: "local", sessionId: "acceptance-terminal", generation: "e2e" });
      await expect($(".terminal-exited")).toHaveText("exited");

      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeDisplayed();
    } finally {
      if (await app.terminalPanel.isDisplayed()) await app.deleteTerminalButton.click();
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("shows a terminal startup failure inside the terminal", async () => {
    await resetApp();
    await startTemporaryConversation({ "shared_terminal:start": { error: "Terminal launch rejected" }, "shared_terminal:resize": {}, "shared_terminal:close": {} });

    try {
      await app.openTerminalButton.click();
      await browser.waitUntil(async () => String(await browser.execute(() => document.querySelector(".xterm-rows")?.textContent)).includes("Could not start terminal: Error: Terminal launch rejected"));
      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeDisplayed();
    } finally {
      if (await app.terminalPanel.isDisplayed()) await app.deleteTerminalButton.click();
      await resetBackend();
    }
  });

  it("reports terminal input failures without closing the active terminal", async () => {
    await resetApp();
    await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {}, "shared_terminal:write_with_draft": { error: "Terminal input channel closed" }, "shared_terminal:close": {} });

    try {
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeDisplayed();
      await browser.waitUntil(() => browser.execute(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false), { timeoutMsg: "Opening the terminal did not focus its input" });
      await browser.keys("x");
      await expect($(".error-toast strong")).toHaveText("Terminal input failed");
      await expect($(".error-toast span")).toHaveText("Error: Terminal input channel closed");
      await expect(app.terminalPanel).toBeDisplayed();
      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeDisplayed();
    } finally {
      if (await app.terminalPanel.isDisplayed()) await app.deleteTerminalButton.click();
      await resetBackend();
    }
  });

  it("copies a completed response and its code block", async () => {
    const response = "Here is the answer:\n\n```ts\nconst answer = 42;\n```";

    const history = {
      entries: [
        { type: "message", id: "copy-user", parentId: null, message: { role: "user", content: "Show the answer", timestamp: 1 } },
        { type: "message", id: "copy-assistant", parentId: "copy-user", message: { role: "assistant", content: response, timestamp: 2 } },
      ],
      leafId: "copy-assistant",
    };

    await mockBackend({ ...connectedSessionResponses("copy-session"), "pi_command:get_entries": history });

    try {
      await browser.execute(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { window.__e2eClipboard = text; } } }));
      await emitPiEvent({ type: "session_switched" });
      await expect($(".assistant-message")).toHaveText(expect.stringContaining("const answer = 42;"));

      await expect($(".assistant-message").$('button[aria-label^="Copy assistant response"]')).toBeEnabled();
      await browser.execute(() => {
        const element = document.querySelector('.assistant-message button[aria-label^="Copy assistant response"]');

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.click();
      });
      expect(await browser.execute(() => window.__e2eClipboard)).toBe(response);
      await $('button[aria-label="Copy code"]').click();
      await expect($('button[aria-label="Code copied"]')).toBeDisplayed();
      expect(await browser.execute(() => window.__e2eClipboard)).toBe("const answer = 42;");
    } finally {
      await resetBackend();
    }
  });

  it("presents skill references and compacts repeated intermediate work", async () => {
    const disableDebug = $('button[aria-label="Disable debug mode"]');

    if (await disableDebug.isExisting()) await disableDebug.click();

    const history = {
      entries: [
        { type: "message", id: "work-user", parentId: null, message: { role: "user", content: '<skill name="ponytail" location="/tmp/ponytail/SKILL.md">\nReferences are relative to /tmp/ponytail.\n\nhidden skill instructions</skill>\n\nReview the implementation', timestamp: 1_000 } },
        { type: "message", id: "work-thinking", parentId: "work-user", message: { role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the behavior carefully" }], timestamp: 1_500 } },
        { type: "message", id: "work-tool-one", parentId: "work-thinking", message: { role: "toolResult", toolName: "read", content: "First file inspected", timestamp: 2_000 } },
        { type: "message", id: "work-tool-two", parentId: "work-tool-one", message: { role: "toolResult", toolName: "read", content: "Second file inspected", timestamp: 2_500 } },
        { type: "message", id: "work-final", parentId: "work-tool-two", message: { role: "assistant", content: "The implementation satisfies the acceptance behavior.", timestamp: 4_000 } },
      ],
      leafId: "work-final",
    };

    await mockBackend({ ...connectedSessionResponses("work-session"), "pi_command:get_entries": history });

    try {
      await emitPiEvent({ type: "session_switched" });
      await expect($(".skill-reference")).toHaveText("$ponytail");
      await expect($(".user-message")).toHaveText(expect.stringContaining("Review the implementation"));
      expect(await $(".user-message").getText()).not.toContain("hidden skill instructions");

      const work = $(".work-group");
      await expect(work.$("summary")).toHaveText("Worked for 3s");
      await work.$("summary").click();
      await expect(work).toHaveText(expect.stringContaining("Inspecting the behavior carefully"));
      await expect(work).toHaveText(expect.stringContaining("read x2"));
      await $('button[aria-label="Enable debug mode"]').click();
      await expect(work.$$(".tool-event")).toBeElementsArrayOfSize(2);
      let index = 0;

      for (const summary of await work.$$(".tool-event summary")) {
        const content = ["First file inspected", "Second file inspected"][index++];
        await updateBackendResponse("pi_command:get_tool_payload", { chunk: JSON.stringify({ content }), length: 0, revision: "tool" });
        await summary.click();
        await expect(work).toHaveText(expect.stringContaining(content));
      }

      await expect(work).toHaveText(expect.stringContaining("First file inspected"));
      await expect(work).toHaveText(expect.stringContaining("Second file inspected"));
      await expect($('//article[contains(@class,"assistant-message")][contains(.,"The implementation satisfies the acceptance behavior.")]')).toBeDisplayed();
    } finally {
      await resetBackend();
    }
  });

  it("branches the conversation from the selected response", async () => {
    const history = {
      entries: [
        { type: "message", id: "branch-user", parentId: null, message: { role: "user", content: "Establish the branch point", timestamp: 1 } },
        { type: "message", id: "branch-assistant", parentId: "branch-user", message: { role: "assistant", content: "This response can be branched.", timestamp: 2 } },
      ],
      leafId: "branch-assistant",
    };

    await mockBackend({
      ...connectedSessionResponses("branch-session"),
      "pi_command:get_state": { ...connectedSessionResponses("branch-session")["pi_command:get_state"], sessionFile: "/tmp/branch-session.jsonl" },
      "pi_command:get_entries": history,
      "pi_command:fork_after": {},
    });

    try {
      await emitPiEvent({ type: "session_switched" });
      const branch = $(".assistant-message").$('button[aria-label="Fork"]');
      await expect(branch).toBeEnabled();
      await browser.execute(() => {
        const element = document.querySelector('.assistant-message button[aria-label="Fork"]');

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.click();
      });

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.type === "fork_after"));
      expect((await backendCalls()).find(({ args }) => args.command?.type === "fork_after")?.args.command).toMatchObject({ type: "fork_after", entryId: "branch-assistant" });
      await expect($(".user-message .message-body")).toHaveText("Establish the branch point");
      await expect($(".assistant-message")).toHaveText(expect.stringContaining("This response can be branched."));
    } finally {
      await resetBackend();
    }
  });

  it("steers a live response immediately", async () => {
    await startTemporaryConversation({ "pi_command:steer": {} });

    try {
      await emitPiEvent({ type: "agent_start" });
      await app.prepareMessage("Focus on the acceptance criteria");
      await browser.execute(() => {
        const element = document.querySelector('[aria-label="Message piop"]');

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      });

      await expect(app.composer).toHaveValue("");
      await emitPiEvent({ type: "queue_update", steering: ["Focus on the acceptance criteria"], followUp: [], pendingMessages: [{ id: "steer-criteria", message: "Focus on the acceptance criteria", behavior: "steer" }] });
      await expect($$(".pending-message")).toBeElementsArrayOfSize(1);
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.type === "steer"));
      expect((await backendCalls()).find(({ args }) => args.command?.type === "steer")?.args.command).toMatchObject({ type: "steer", message: "Focus on the acceptance criteria" });
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [], pendingMessages: [] });
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("queues a follow-up and can stop a streaming response", async () => {
    const pending = { id: "follow-up", message: "Check this after the current response", behavior: "followUp" };
    await startTemporaryConversation({ "pi_command:follow_up": {}, "pi_command:abort": {}, "pi_command:change_pending": {}, "pi_command:clear_queue": { steering: [], followUp: [pending.message] } });

    try {
      await emitPiEvent({ type: "agent_start" });
      await app.prepareMessage("Check this after the current response");
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [pending.message], pendingMessages: [pending] });
      await browser.keys("Enter");

      await expect(app.composer).toHaveValue("");
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [pending.message], pendingMessages: [pending] });
      await expect($$(".pending-message")).toBeElementsArrayOfSize(1);
      await $('button[aria-label="Stop piop"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => ["follow_up", "abort"].includes(String(args.command?.type))).length === 2);
      expect((await backendCalls()).filter(({ args }) => ["follow_up", "abort"].includes(String(args.command?.type))).map(({ args }) => args.command)).toMatchObject([
        { type: "follow_up", message: pending.message }, { type: "abort" },
      ]);
      await $('button[aria-label="Remove queued message: Check this after the current response"]').click();
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [], pendingMessages: [] });
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("returns extension input through the piop event bridge", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-input", method: "input", title: "Choose a release name", placeholder: "Release name", prefill: "alpha" });
      const input = $('input[aria-label="Release name"]');
      await expect(input).toHaveValue("alpha");
      await input.setValue("beta");
      await $('//dialog//button[normalize-space(.)="Continue"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.type === "extension_ui_response"));
      expect((await backendCalls()).find(({ args }) => args.command?.type === "extension_ui_response")?.args.command).toMatchObject({ type: "extension_ui_response", id: "acceptance-input", value: "beta" });
      await expect(app.extensionDialogHeading).not.toBeExisting();
    } finally {
      await resetBackend();
    }
  });

  it("submits extension input from the keyboard and supports negative confirmation", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });

    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-enter-input", method: "input", title: "Release tag", placeholder: "Release tag", prefill: "alpha" });
      const input = $('input[aria-label="Release tag"]');
      await input.setValue("beta");
      await browser.keys("Enter");
      await expect(app.extensionDialogHeading).not.toBeExisting();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-no-confirm", method: "confirm", title: "Publish release?" });
      await $('//dialog//button[normalize-space(.)="No"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").length === 2);
      expect((await backendCalls()).filter(({ args }) => args.command?.type === "extension_ui_response").map(({ args }) => args.command)).toMatchObject([
        { type: "extension_ui_response", id: "acceptance-enter-input", value: "beta" },
        { type: "extension_ui_response", id: "acceptance-no-confirm", confirmed: false },
      ]);
    } finally {
      await resetBackend();
    }
  });
});
