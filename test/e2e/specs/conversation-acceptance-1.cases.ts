import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, pressShortcut, connectedSessionResponses } from './acceptance-fixture.js';

describe("Conversation acceptance", () => {
  before(async () => {
    await resetApp();
  });
  beforeEach(async () => {
    await app.openConversations();
    await app.clearMessage();
  });

  it("gives the user the essential controls for starting work", async () => {
    await expect(app.composer).toBeDisplayed();
    await expect(app.openTerminalButton).toBeClickable();
    await expect(app.modelPicker).toBeDisplayed();
    await expect(app.thinkingLevelPicker).toBeDisplayed();
    await app.thinkingLevelPicker.click();
    expect((await $$('[role="listbox"][aria-label="Thinking level options"] [role="option"]')).length).toBeGreaterThan(0);
    await browser.keys("Escape");
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("does not allow a whitespace-only message", async () => {
    await app.prepareMessage("  \n  ");
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("enables sending a prepared message without losing the draft during navigation", async () => {
    const draft = "Explain how this project starts a piop session";
    await app.prepareMessage(draft);

    await expect(app.sendMessageButton).toBeClickable();
    await app.openSettings();
    await expect(app.settingsHeading).toHaveText("Local daemon settings");

    await app.openConversations();
    await expect(app.composer).toHaveValue(draft);
    await expect(app.sendMessageButton).toBeClickable();
  });

  it("preserves the draft when the user opens and cancels the project chooser", async () => {
    const draft = "Review this workspace";
    await app.prepareMessage(draft);
    await app.openProjectChooser();

    await expect(app.projectDialogHeading).toHaveText("Jump to a folder");
    await expect(app.projectDirectory).toBeDisplayed();
    await app.cancelProjectChooser();

    await expect(app.projectDialogHeading).not.toBeExisting();
    await expect(app.composer).toHaveValue(draft);
  });

  it("offers the current folder when the folder search is empty", async () => {
    await app.openProjectChooser();
    await app.openProjectButton.waitForEnabled();
    await app.projectDirectory.clearValue();
    await expect(app.openProjectButton).toBeEnabled();
    await expect(app.dialogAlert).not.toBeExisting();
    await app.cancelProjectChooser();
  });

  it("opens settings from the keyboard", async () => {
    await browser.keys(["Control", ","]);
    await expect(app.settingsHeading).toHaveText("Client settings");
    await app.openConversations();
  });

  it("controls the conversation panel, terminal, and composer from the keyboard", async () => {
    await app.openSettings();
    await app.openSettingsSection("Keybinds");
    const panelShortcut = await $('input[aria-label="Toggle conversations shortcut"]').getValue();
    const terminalShortcut = await $('input[aria-label="Toggle terminal shortcut"]').getValue();
    const composerShortcut = await $('input[aria-label="Focus composer shortcut"]').getValue();
    await app.openConversations();

    await pressShortcut(panelShortcut);
    await expect($(".session-panel")).not.toBeExisting();
    await pressShortcut(panelShortcut);
    await expect($(".session-panel")).toBeDisplayed();

    await mockBackend({ start_terminal: {}, resize_terminal: {} });
    try {
      await pressShortcut(terminalShortcut);
      await expect(app.terminalPanel).toBeDisplayed();
      await pressShortcut(terminalShortcut);
      await expect(app.terminalPanel).not.toBeExisting();
      await pressShortcut(composerShortcut);
      expect(await browser.execute(() => document.activeElement?.getAttribute("aria-label"))).toBe("Message piop");
    } finally {
      if (await app.terminalPanel.isExisting()) await pressShortcut(terminalShortcut);
      await resetBackend();
    }
  });

  it("searches conversations and explains when none match", async () => {
    const query = "__webdriver_no_matching_conversation__";
    await app.conversationSearch.setValue(query);

    await expect(app.emptyConversationSearch).toHaveText(`No conversations match “${query}”.`);
    await app.conversationSearch.clearValue();
  });

  it("shows indexed conversations and their available actions", async () => {
    await mockBackend({ list_sessions: [{ id: "acceptance-indexed", path: "/tmp/acceptance-indexed.jsonl", name: "Acceptance indexed conversation", project: "Acceptance project", cwd: "/tmp", preview: "Indexed preview", messageCount: 2, hostId: "local" }] });
    try {
      await app.conversationSearch.setValue("Acceptance indexed");
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining("Acceptance indexed conversation"));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));

      const menu = $('[role="menu"][aria-label="Acceptance indexed conversation actions"]');
      await expect(menu).toBeDisplayed();
      await expect(menu.$$("[role='menuitem']")).toBeElementsArrayOfSize(5);
      await expect(session.$('button[aria-label^="Archive "]')).toBeExisting();
      await browser.keys("Escape");
      await expect(menu).not.toBeExisting();
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("collapses and restores a project's conversation group", async () => {
    const indexed = { id: "acceptance-collapse", path: "/tmp/acceptance-collapse.jsonl", name: "Acceptance grouped conversation", project: "Collapsible project", cwd: "/tmp/acceptance-collapse-project", preview: "Grouped preview", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed] });
    try {
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item")).toHaveText(expect.stringContaining(indexed.name));
      await app.conversationSearch.clearValue();

      const project = $('//button[contains(@class,"project-label")][.//span[normalize-space(.)="Collapsible project"]]');
      const groupedSession = $('//section[contains(@class,"project")][.//span[normalize-space(.)="Collapsible project"]]//div[contains(@class,"session-item")]');
      await expect(project).toHaveAttribute("aria-expanded", "true");
      await project.click();
      await expect(project).toHaveAttribute("aria-expanded", "false");
      await expect(groupedSession).not.toBeDisplayed();

      await project.click();
      await expect(project).toHaveAttribute("aria-expanded", "true");
      await expect(groupedSession).toBeDisplayed();
    } finally {
      await resetBackend();
    }
  });

  it("clones an indexed conversation from its visible action", async () => {
    const indexed = { id: "acceptance-clone", path: "/tmp/acceptance-clone.jsonl", name: "Acceptance clone target", project: "Acceptance project", cwd: "/tmp", preview: "Clone preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], ...connectedSessionResponses(indexed.id), "pi_command:clone": {} });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item")).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Clone conversation"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "clone"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "clone")?.args.command).toEqual({ type: "clone" });
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("explains when a conversation's project directory cannot be opened", async () => {
    const indexed = { id: "acceptance-open-directory", path: "/tmp/acceptance-open-directory.jsonl", name: "Acceptance directory target", project: "Acceptance project", cwd: "/missing/acceptance-project", preview: "Directory preview", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], open_project_directory: { error: "The project directory is unavailable" } });
    try {
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item")).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Open project directory"]').click();

      await expect($(".error-toast strong")).toHaveText("Could not open project directory");
      await expect($(".error-toast span")).toHaveText("The project directory is unavailable");
      expect((await backendCalls()).find(({ command }) => command === "open_project_directory")?.args).toEqual({ cwd: indexed.cwd, hostId: "local" });
      await $(".error-toast button").click();
    } finally {
      await app.conversationSearch.clearValue();
      if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("relocates a conversation whose original project directory moved", async () => {
    const indexed = { id: "acceptance-relocate", path: "/tmp/acceptance-relocate.jsonl", name: "Acceptance relocation target", project: "Moved project", cwd: "/missing/original-project", cwdExists: false, preview: "Relocation preview", messageCount: 3, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], relocate_session: {}, start_pi: {}, ...connectedSessionResponses(indexed.id) });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await session.$(".session-main").click();

      await expect(app.extensionDialogHeading).toHaveText("Locate conversation project");
      const replacement = $('input[aria-label="Replacement project directory"]');
      await replacement.clearValue();
      await $('//dialog//button[normalize-space(.)="Continue"]').click();
      await expect($('[role="alert"]')).toHaveText("Path can't be empty");

      await replacement.setValue("/tmp/relocated-acceptance-project");
      await updateBackendResponse("list_sessions", [{ ...indexed, cwd: "/tmp/relocated-acceptance-project", cwdExists: true }]);
      await $('//dialog//button[normalize-space(.)="Continue"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "relocate_session") && (await backendCalls()).some(({ command }) => command === "start_pi"));
      expect((await backendCalls()).find(({ command }) => command === "relocate_session")?.args).toEqual({ sessionPath: indexed.path, cwd: "/tmp/relocated-acceptance-project", hostId: "local" });
      expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/relocated-acceptance-project", sessionPath: indexed.path, hostId: "local" }));
    } finally {
      await app.conversationSearch.clearValue();
      if (await app.extensionDialogHeading.isExisting()) await $('//dialog//button[normalize-space(.)="Cancel"]').click();
      await resetApp();
    }
  });

  it("reports when relocating a moved conversation fails", async () => {
    const indexed = { id: "acceptance-relocate-failure", path: "/tmp/acceptance-relocate-failure.jsonl", name: "Acceptance failed relocation", project: "Moved project", cwd: "/missing/failed-project", cwdExists: false, preview: "Failed relocation preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], relocate_session: { error: "Replacement directory is not a project" } });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await session.$(".session-main").click();
      await $('input[aria-label="Replacement project directory"]').setValue("/tmp/not-a-project");
      await $('//dialog//button[normalize-space(.)="Continue"]').click();

      await expect($(".dialog-error")).toHaveText("Replacement directory is not a project");
      expect((await backendCalls()).find(({ command }) => command === "relocate_session")?.args).toEqual({ sessionPath: indexed.path, cwd: "/tmp/not-a-project", hostId: "local" });
    } finally {
      await app.conversationSearch.clearValue();
      if (await app.extensionDialogHeading.isExisting()) await $('//dialog//button[normalize-space(.)="Cancel"]').click();
      if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("archives an indexed conversation through its visible action", async () => {
    const indexed = { id: "acceptance-archive", path: "/tmp/acceptance-archive.jsonl", name: "Acceptance archive target", project: "Acceptance project", cwd: "/tmp", preview: "Archive preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], load_git_diffs: {}, stop_pi: {}, archive_session: {} });
    try {
      await app.conversationSearch.setValue("Acceptance archive target");
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await app.confirmAction(`Archive “${indexed.name}”?`, () => session.$(`button[aria-label="Archive ${indexed.name}"]`).click());

      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "archive_session"));
      expect((await backendCalls()).find(({ command }) => command === "archive_session")?.args).toEqual({ sessionPath: indexed.path, hostId: "local", terminalIds: [] });
    } finally {
      await app.conversationSearch.clearValue();
      await resetApp();
    }
  });

  it("keeps a conversation available when archiving fails", async () => {
    const indexed = { id: "acceptance-archive-failure", path: "/tmp/acceptance-archive-failure.jsonl", name: "Acceptance archive failure", project: "Acceptance project", cwd: "/tmp", preview: "Archive failure preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], load_git_diffs: {}, stop_pi: {}, archive_session: { error: "Archive destination is unavailable" } });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await app.confirmAction(`Archive “${indexed.name}”?`, () => session.$(`button[aria-label="Archive ${indexed.name}"]`).click());

      await expect($(".error-toast strong")).toHaveText("Could not archive conversation");
      await expect($(".error-toast span")).toHaveText("Archive destination is unavailable");
      await expect($(`.session-item[data-session-key="local:${indexed.id}"]`)).toBeDisplayed();
      await $(".error-toast button").click();
    } finally {
      await app.conversationSearch.clearValue();
      if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("opens an indexed conversation as a second chat shell and closes it by selecting that session", async () => {
    const indexed = { id: "acceptance-split", path: "/tmp/acceptance-split.jsonl", name: "Acceptance split target", project: "Acceptance project", cwd: "/tmp", preview: "Split preview", messageCount: 1, hostId: "local" };
    await mockBackend({
      list_sessions: [indexed], start_pi: {}, stop_pi: {}, ...connectedSessionResponses(indexed.id),
      load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" },
      "pi_command:get_state": { ...connectedSessionResponses(indexed.id)["pi_command:get_state"], sessionFile: indexed.path, messageCount: indexed.messageCount },
    });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Split pane"]').click();

      const split = $(`section[aria-label="Split conversation: ${indexed.name}"]`);
      await expect(split).toBeDisplayed();
      await expect($$(".chat-panes .chat-shell")).toBeElementsArrayOfSize(2);
      await split.$('textarea[aria-label="Message piop"]').waitForEnabled();
      const splitRuntimeId = (await backendCalls()).find(({ command, args }) => command === "start_pi" && args.sessionPath === indexed.path)?.args.runtimeId;
      expect(splitRuntimeId).toBeTruthy();
      await session.$(".session-main").click();
      await expect(split).not.toBeExisting();
      await app.composer.waitForEnabled();
      expect((await backendCalls()).some(({ command, args }) => command === "stop_pi" && args.runtimeId === splitRuntimeId)).toBe(false);
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("renames an indexed conversation", async () => {
    const indexed = { id: "acceptance-rename", path: "/tmp/acceptance-rename.jsonl", name: "Acceptance rename target", project: "Acceptance project", cwd: "/tmp", preview: "Rename preview", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], ...connectedSessionResponses(indexed.id), "pi_command:set_session_name": {} });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item")).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Rename conversation"]').click();

      const input = $('input[aria-label="Rename conversation"]');
      await expect(input).toHaveValue(indexed.name);
      await input.setValue("Renamed acceptance conversation");
      await $('//dialog//button[normalize-space(.)="Continue"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "set_session_name"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "set_session_name")?.args.command).toEqual({ type: "set_session_name", name: "Renamed acceptance conversation" });
    } finally {
      await app.conversationSearch.clearValue();
      await resetApp();
    }
  });
});
