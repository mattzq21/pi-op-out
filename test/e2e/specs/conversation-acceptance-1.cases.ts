import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { failureState, mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, pressShortcut, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

describe("Conversation acceptance", () => {
  beforeEach(async () => {
    await resetApp();
    await app.openConversations();
    await app.clearMessage();
  });

  it("gives the user the essential controls for starting work", async () => {
    await expect(app.composer).toBeDisplayed();
    await expect(app.openTerminalButton).toBeDisplayed();
    await expect(app.openTerminalButton).toBeDisabled();
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
    await expect(app.settingsHeading).toHaveText("Daemon settings");

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

    await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {} });

    try {
      await pressShortcut(terminalShortcut);
      await expect(app.terminalPanel).toBeDisplayed();
      await pressShortcut(terminalShortcut);
      await expect(app.terminalPanel).not.toBeDisplayed();
      await pressShortcut(composerShortcut);
      await browser.waitUntil(async () => await browser.execute(() => document.activeElement?.getAttribute("aria-label")) === "Message piop");
    } finally {
      if (await app.terminalPanel.isDisplayed()) await pressShortcut(terminalShortcut);
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
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining("Acceptance indexed conversation"));
      await expect(session.$(".session-main")).toBeDisplayed();
      await browser.execute(() => {
        const element = document.querySelector(".session-item");

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      });

      const menu = $('[role="menu"][aria-label="Acceptance indexed conversation actions"]');
      await expect(menu).toBeDisplayed();
      await expect(menu.$$("[role='menuitem']")).toBeElementsArrayOfSize(3);
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
    await browser.execute(async (session) => {
      const group = { id: `local:${session.cwd}`, name: session.project, cwd: session.cwd, hostId: "local" };
      const tauri = window.__TAURI_INTERNALS__;
      await tauri.invoke("plugin:event|emit", { event: "pi://groups-changed", payload: { groups: [group], parents: {}, assignments: { [`local:${session.id}`]: group.id }, removedProjects: [] } });
    }, indexed);

    try {
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item .session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await app.conversationSearch.click();
      await browser.keys(["Control", "a"]);
      await browser.keys("Backspace");

      const project = $('//section[contains(@class,"project")][.//span[normalize-space(.)="Collapsible project"]]//button[contains(@class,"project-disclosure")]');
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

  it("opens an indexed conversation in a new window from its visible action", async () => {
    const indexed = { id: "acceptance-clone", path: "/tmp/acceptance-clone.jsonl", name: "Acceptance clone target", project: "Acceptance project", cwd: "/tmp", preview: "Clone preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], ...connectedSessionResponses(indexed.id), new_window: "acceptance-window" });

    try {
      await emitPiEvent({ type: "session_switched" });
      await app.conversationSearch.setValue(indexed.name);
      await expect($(".session-item .session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await browser.execute(() => {
        const element = document.querySelector(".session-item");

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      });
      await $('//div[@role="menu"]//button[normalize-space(.)="Open in new window"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "new_window"));
      expect((await backendCalls()).find(({ command }) => command === "new_window")?.args.target).toEqual({ cwd: indexed.cwd, sessionId: indexed.id, sessionPath: indexed.path, hostId: "local" });
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
      await expect($(".session-item .session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await browser.execute(() => {
        const element = document.querySelector(".session-item");

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      });
      await $('//div[@role="menu"]//button[normalize-space(.)="Open project directory"]').click();

      await expect($(".error-toast strong")).toHaveText("Could not open project directory");
      await expect($(".error-toast span")).toHaveText("The project directory is unavailable");
      expect((await backendCalls()).find(({ command }) => command === "open_project_directory")?.args).toMatchObject({ cwd: indexed.cwd, hostId: "local" });
      await $(".error-toast button").click();
    } finally {
      await resetApp();
    }
  });

  it("relocates a conversation whose original project directory moved", async () => {
    const indexed = { id: "acceptance-relocate", path: "/tmp/acceptance-relocate.jsonl", name: "Acceptance relocation target", project: "Moved project", cwd: "/missing/original-project", cwdExists: false, preview: "Relocation preview", messageCount: 3, hostId: "local" };
    const groups = { groups: [], parents: {}, assignments: { [`local:${indexed.id}`]: "__pi-desktop-dirless__" }, removedProjects: [] };
    await mockBackend({ list_sessions: [indexed], load_session_groups: groups, change_session_groups: groups, validate_project_directory: "/tmp/relocated-acceptance-project", create_temporary_chat: { cwd: "/tmp/relocated-acceptance-project", sessionId: "dirless" }, "recover_missing_session:inspect": { canRecoverRemote: false }, "recover_missing_session:empty": { cwd: "/tmp/relocated-acceptance-project", warnings: [] }, ...connectedSessionResponses(indexed.id) });

    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await updateBackendResponse("list_sessions", [{ ...indexed, cwd: "/tmp/relocated-acceptance-project", cwdExists: true }]);
      await session.$(".session-main").click();
      await expect($("#missing-directory-title")).toHaveText("Working directory is missing");
      await $('//dialog//button[normalize-space(.)="Create empty folder"]').click();

      await browser.waitUntil(async () => {
        const calls = await backendCalls();
        return calls.some(({ command, args }) => command === "recover_missing_session" && args.action === "empty")
          && calls.some(({ command, args }) => command === "start_pi" && args.sessionPath === indexed.path);
      });
      expect((await backendCalls()).find(({ command, args }) => command === "recover_missing_session" && args.action === "empty")?.args).toMatchObject({ sessionPath: indexed.path, action: "empty", hostId: "local" });
      expect((await backendCalls()).find(({ command, args }) => command === "start_pi" && args.sessionPath === indexed.path)?.args).toEqual(expect.objectContaining({ cwd: "/tmp/relocated-acceptance-project", sessionPath: indexed.path, hostId: "local" }));
      await expect(app.composer).toBeEnabled();
    } catch (cause) {
      throw new Error(String(cause) + " " + await failureState(), { cause });
    } finally {
      await resetApp();
    }
  });

  it("reports when relocating a moved conversation fails", async () => {
    const indexed = { id: "acceptance-relocate-failure", path: "/tmp/acceptance-relocate-failure.jsonl", name: "Acceptance failed relocation", project: "Moved project", cwd: "/missing/failed-project", cwdExists: false, preview: "Failed relocation preview", messageCount: 2, hostId: "local" };
    const groups = { groups: [], parents: {}, assignments: { [`local:${indexed.id}`]: "__pi-desktop-dirless__" }, removedProjects: [] };
    await mockBackend({ list_sessions: [indexed], load_session_groups: groups, change_session_groups: groups, create_temporary_chat: { cwd: "/tmp/dirless-failure", sessionId: "dirless" }, "recover_missing_session:inspect": { canRecoverRemote: false }, "recover_missing_session:empty": { error: "Dirless directory is unavailable" } });

    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session.$(".session-main")).toBeDisplayed();
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await session.$(".session-main").click();

      await expect($("#missing-directory-title")).toHaveText("Working directory is missing");
      await $('//dialog//button[normalize-space(.)="Create empty folder"]').click();
      await expect($(".dialog-error")).toHaveText("Dirless directory is unavailable");
      expect((await backendCalls()).find(({ command, args }) => command === "recover_missing_session" && args.action === "empty")?.args).toMatchObject({ sessionPath: indexed.path, action: "empty", hostId: "local" });
    } finally {
      await resetApp();
    }
  });

  it("archives an indexed conversation through its visible action", async () => {
    const indexed = { id: "acceptance-archive", path: "/tmp/acceptance-archive.jsonl", name: "Acceptance archive target", project: "Acceptance project", cwd: "/tmp", preview: "Archive preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], stop_pi: false, archive_session: {} });

    try {
      await app.conversationSearch.setValue("Acceptance archive target");
      const session = $(".session-item");
      await expect(session.$(".session-main")).toBeDisplayed();
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await session.moveTo();
      await session.$(`button[aria-label="Archive ${indexed.name}"]`).click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "archive_session"));
      expect((await backendCalls()).find(({ command }) => command === "archive_session")?.args).toMatchObject({ sessionPath: indexed.path, hostId: "local", terminalIds: [] });
    } finally {
      await app.conversationSearch.clearValue();
      await resetApp();
    }
  });

  it("keeps a conversation available when archiving fails", async () => {
    const indexed = { id: "acceptance-archive-failure", path: "/tmp/acceptance-archive-failure.jsonl", name: "Acceptance archive failure", project: "Acceptance project", cwd: "/tmp", preview: "Archive failure preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], stop_pi: false, archive_session: { error: "Archive destination is unavailable" } });

    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session.$(".session-main")).toBeDisplayed();
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await session.moveTo();
      await session.$(`button[aria-label="Archive ${indexed.name}"]`).click();

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
    await startTemporaryConversation({});
    const indexed = { id: "acceptance-split", path: "/tmp/acceptance-split.jsonl", name: "Acceptance split target", project: "Acceptance project", cwd: "/tmp", preview: "Split preview", messageCount: 1, hostId: "local" };
    await mockBackend({
      list_sessions: [indexed], ...connectedSessionResponses(indexed.id),
      load_app_settings: { ...defaultSettings, defaultThinking: "high" },
      "pi_command:get_state": { ...connectedSessionResponses(indexed.id)["pi_command:get_state"], sessionFile: indexed.path, messageCount: indexed.messageCount },
    });

    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session.$(".session-main")).toBeDisplayed();
      await expect(session.$(".session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await emitPiEvent({ type: "extension_ui_request", id: "indexed-review", method: "input", title: "__pi_desktop_review__", placeholder: JSON.stringify({ task: "Review this conversation", parentSessionId: "parent", cwd: indexed.cwd, sessionId: indexed.id, sessionPath: indexed.path }) });
      const split = $('section[aria-label="Split conversation: Code review"]');
      await expect(split).toBeDisplayed();
      await expect($$(".chat-panes .chat-shell")).toBeElementsArrayOfSize(2);
      await split.$('textarea[aria-label="Message piop"]').waitForEnabled();
      const splitRuntimeId = (await backendCalls()).find(({ command, args }) => command === "start_pi" && args.sessionId === indexed.id)?.args.runtimeId;
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
      await expect($(".session-item .session-main")).toBeDisplayed();
      await expect($(".session-item .session-main")).toHaveAttribute("aria-label", expect.stringContaining(indexed.name));
      await browser.execute(() => {
        const element = document.querySelector(".session-item");

        if (!(element instanceof HTMLElement)) throw new Error("Expected page element was not found");
        element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      });
      await $('//div[@role="menu"]//button[normalize-space(.)="Rename conversation"]').click();

      const input = $('input[aria-label="Rename conversation"]');
      await expect(input).toHaveValue(indexed.name);
      const name = "Renamed acceptance conversation";
      await input.setValue(name);
      await expect(input).toHaveValue(name);
      await $('//dialog//button[normalize-space(.)="Continue"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.type === "set_session_name"));
      expect((await backendCalls()).find(({ args }) => args.command?.type === "set_session_name")?.args.command).toMatchObject({ type: "set_session_name", name: name.slice(0, 30) });
    } finally {
      await resetApp();
    }
  });
});
