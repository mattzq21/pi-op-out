import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, connectedSessionResponses } from './acceptance-fixture.js';

describe("Conversation lifecycle", () => {
  beforeEach(async () => {
    await resetApp();
  });

  it("keeps a separate composer draft for each conversation", async () => {
    const current = { id: "ae9071ac-0954-4e01-bf92-bd969ed50c47", path: "/tmp/draft-current.jsonl", name: "Draft current conversation", project: "Draft project", cwd: "/tmp", preview: "Current draft", messageCount: 0, hostId: "local" };
    const target = { id: "1d26ae02-2dfe-48df-a5d3-b8c77fd764b4", path: "/tmp/draft-target.jsonl", name: "Draft target conversation", project: "Draft project", cwd: "/tmp", preview: "Target draft", messageCount: 0, hostId: "local" };
    const state = (sessionId: string) => ({ model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 });
    await mockBackend({ list_sessions: [current, target], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" }, ...connectedSessionResponses(""), "pi_command:set_model": {} });

    try {
      await emitPiEvent({ type: "session_switched" });
      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await app.prepareMessage("Draft belonging to the current conversation");

      await updateBackendResponse("pi_command:get_state", state(target.id));
      await app.conversationSearch.setValue(target.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await expect(app.composer).toHaveValue("");
      await app.prepareMessage("Draft belonging to the target conversation");

      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await expect(app.composer).toHaveValue("Draft belonging to the current conversation");

      await updateBackendResponse("pi_command:get_state", state(target.id));
      await app.conversationSearch.setValue(target.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await expect(app.composer).toHaveValue("Draft belonging to the target conversation");
      await app.clearMessage();
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("keeps split-pane drafts separate from the main conversation", async () => {
    const indexed = { id: "draft-split", path: "/tmp/draft-split.jsonl", name: "Draft split conversation", project: "Draft project", cwd: "/tmp", preview: "Split draft", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" }, ...connectedSessionResponses(""), "pi_command:set_model": {} });

    const openSplit = async () => {
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item")).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Split pane"]').click();
      const split = $(`section[aria-label="Split conversation: ${indexed.name}"]`);
      await expect(split).toBeDisplayed();

      return split;
    };

    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("Main conversation draft");
      let split = await openSplit();
      await split.$('textarea[aria-label="Message piop"]').setValue("Independent split-pane draft");
      await split.$('button[aria-label="Close split pane"]').click();
      await expect(app.composer).toHaveValue("Main conversation draft");

      split = await openSplit();
      await expect(split.$('textarea[aria-label="Message piop"]')).toHaveValue("Independent split-pane draft");
      await split.$('button[aria-label="Close split pane"]').click();
      await expect(app.composer).toHaveValue("Main conversation draft");
      await app.clearMessage();
    } finally {
      const split = $(`section[aria-label="Split conversation: ${indexed.name}"]`);

      if (await split.isExisting()) await split.$('button[aria-label="Close split pane"]').click();
      await app.conversationSearch.clearValue();
      await app.clearMessage();
      await resetBackend();
    }
  });

  it("keeps terminal tabs isolated between conversations", async () => {
    const current = { id: "terminal-current", path: "/tmp/terminal-current.jsonl", name: "Terminal current conversation", project: "Terminal project", cwd: "/tmp", preview: "Current terminal", messageCount: 1, hostId: "local" };
    const target = { id: "terminal-target", path: "/tmp/terminal-target.jsonl", name: "Terminal target conversation", project: "Terminal project", cwd: "/tmp", preview: "Target terminal", messageCount: 1, hostId: "local" };
    const state = (sessionId: string) => ({ model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, messageCount: 1, pendingMessageCount: 0 });
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" };
    await mockBackend({ list_sessions: [current, target], start_pi: {}, stop_pi: {}, ...connectedSessionResponses("terminal-bootstrap"), "pi_command:set_model": {}, load_app_settings: settings, start_terminal: {}, resize_terminal: {}, close_terminal: {} });

    try {
      await browser.execute(() => {
        document.querySelectorAll<HTMLButtonElement>('.error-toast button[aria-label^="Dismiss"]').forEach((button) => button.click());
      });
      await emitPiEvent({ type: "session_switched" });
      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);

      await updateBackendResponse("pi_command:get_state", state(target.id));
      await app.conversationSearch.setValue(target.name);
      await $(".session-item .session-main").click();
      await expect(app.terminalPanel).not.toBeExisting();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(1);

      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await expect(app.terminalPanel).not.toBeExisting();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);
      await app.closeTerminalButton.click();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("starts a replacement session and closes the archived conversation's terminal", async () => {
    const indexed = { id: "archive-active", path: "/tmp/archive-active.jsonl", name: "Active archive conversation", project: "Archive project", cwd: "/tmp", preview: "Active archive", messageCount: 2, hostId: "local" };
    const replacementState = { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId: "archive-replacement", messageCount: 0, pendingMessageCount: 0 };
    await mockBackend({ list_sessions: [indexed], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" }, ...connectedSessionResponses(""), "pi_command:set_model": {}, "pi_command:new_session": {}, archive_session: {}, start_terminal: {}, resize_terminal: {}, close_terminal: {} });

    try {
      await emitPiEvent({ type: "session_switched" });
      await updateBackendResponse("pi_command:get_state", { ...replacementState, sessionId: indexed.id });
      await app.conversationSearch.setValue(indexed.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeDisplayed();
      await updateBackendResponse("pi_command:get_state", replacementState);
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await session.moveTo();
      await app.confirmAction(`Archive “${indexed.name}”?`, () => session.$(`button[aria-label="Archive ${indexed.name}"]`).click());

      await expect(app.terminalPanel).not.toBeExisting();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "archive_session"));
      await browser.waitUntil(async () => { const calls = await backendCalls(); const archived = calls.findIndex(({ command }) => command === "archive_session");

      return calls.slice(archived + 1).some(({ command, args }) => command === "start_pi" && !args.sessionPath); }, { timeoutMsg: "Archiving did not start a fresh runtime" });
      const calls = await backendCalls();
      const terminalId = calls.find(({ command }) => command === "start_terminal")?.args.terminalId;
      expect(calls.find(({ command }) => command === "archive_session")?.args.terminalIds).toEqual([terminalId]);
    } finally {
      if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("starts a fresh conversation in the selected project from the keyboard", async () => {
    const selected = { id: "keyboard-session", path: "/tmp/keyboard-session.jsonl", name: "Keyboard conversation", project: "Keyboard project", cwd: "/tmp", preview: "Keyboard", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [selected], stop_pi: {}, start_pi: {}, ...connectedSessionResponses("") });

    try {
      await app.openConversations();
      await emitPiEvent({ type: "session_switched" });
      await updateBackendResponse("pi_command:get_state", { ...connectedSessionResponses(selected.id)["pi_command:get_state"], messageCount: 2, sessionFile: selected.path });
      await app.conversationSearch.setValue(selected.name);
      await $(".session-item .session-main").click();
      await app.composer.waitForEnabled();
      await app.prepareMessage("Discard this old draft");
      await updateBackendResponse("pi_command:get_state", connectedSessionResponses("keyboard-new-session")["pi_command:get_state"]);
      const callCount = (await backendCalls()).length;
      await browser.keys(["Control", "n"]);

      await expect(app.composer).toHaveValue("");
      await app.prepareMessage("Begin the new conversation");
      await app.sendMessageButton.click();
      await browser.waitUntil(async () => (await backendCalls()).slice(callCount).some(({ command }) => command === "start_pi"));
      const starts = (await backendCalls()).slice(callCount).filter(({ command }) => command === "start_pi");
      expect(starts).toHaveLength(1);
      expect(starts[0].args).toMatchObject({ cwd: selected.cwd, hostId: selected.hostId });
      expect(starts[0].args.sessionPath).toBeUndefined();
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });
});
