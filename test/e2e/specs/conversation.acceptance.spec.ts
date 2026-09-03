import { $, $$, browser, expect } from "@wdio/globals";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../../../src/defaults.js";
import { decodeOrchestrationValue, encodeOrchestrationValue } from "../../../src/lib/orchestrationProtocol.js";
import type { OrchestrationCapability, OrchestrationConfig } from "../../../src/types.js";
import { app } from "../pageobjects/app.page.js";

type BackendCall = { command: string; args: Record<string, unknown>; mocked: boolean };
const installedOrchestrationConfigPath = join(homedir(), ".pi", "agent", "extensions", "pi-orchestration", "config.json");
const callBridge = () => $('textarea[aria-label="E2E calls"]');
const responseBridge = () => $('textarea[aria-label="E2E responses"]');
const mockBackend = async (responses: Record<string, unknown>) => {
  await callBridge().setValue("[]");
  await responseBridge().setValue(JSON.stringify(responses));
};
const backendCalls = async () => (JSON.parse(await callBridge().getValue() || "[]") as Partial<BackendCall>[]).filter((call) => call && typeof call === "object").map((call) => ({
  command: typeof call.command === "string" ? call.command : "",
  args: call.args && typeof call.args === "object" ? call.args : {},
  mocked: call.mocked === true,
}));
const updateBackendResponse = async (command: string, response: unknown) => {
  const responses = JSON.parse(await responseBridge().getValue()) as Record<string, unknown>;
  await responseBridge().setValue(JSON.stringify({ ...responses, [command]: response }));
};
const resetBackend = async () => { await callBridge().setValue("[]"); await responseBridge().setValue("{}"); };
const resetApp = async () => {
  await resetBackend();
  await browser.refresh();
  await app.waitUntilReady();
  await app.composer.waitForEnabled();
};
const emitPiEvent = (payload: Record<string, unknown>) => browser.execute(async (event) => {
  const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  await tauri.invoke("plugin:event|emit", { event: "pi://event", payload: event });
}, payload);
const acceptanceOrchestration = (): OrchestrationCapability => ({
  version: 1,
  active: "default",
  currentAgent: "default",
  config: {
    agents: [
      { name: "default", description: "Default acceptance agent", model: "e2e/acceptance", effort: "high", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read"], skills: [], mcpServers: [] },
      { name: "reviewer", description: "Reviews acceptance changes", model: "e2e/alternate", effort: "off", systemPrompt: "Review carefully.", developerPrompt: "", agentsMd: "", tools: ["read"], skills: [], mcpServers: [] },
    ],
    sequences: [],
  },
});

describe("BUGS-3 regressions", () => {
  before(async () => {
    await resetApp();
  });

  beforeEach(async () => {
    await app.openConversations();
    await app.clearMessage();
  });

  afterEach(async () => {
    if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
    if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
    await app.conversationSearch.clearValue();
    await resetBackend();
  });

  it("keeps a failed rename available for retry", async () => {
    const indexed = { id: "bugs3-rename", path: "/tmp/bugs3-rename.jsonl", name: "Rename target", project: "BUGS-3", cwd: "/tmp", preview: "Rename", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], ...connectedSessionResponses(indexed.id), "pi_command:set_session_name": { error: "Rename failed" } });
    await emitPiEvent({ type: "session_switched" });
    await app.conversationSearch.setValue(indexed.name);
    await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
    await $('//div[@role="menu"]//button[normalize-space(.)="Rename conversation"]').click();

    const input = $('input[aria-label="Rename conversation"]');
    await input.setValue("Name to retry");
    await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();

    await expect(input).toHaveValue("Name to retry");
    await expect($(".dialog-error")).toHaveText("Rename failed");
    await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();
  });

  it("isolates drafts and terminals between fresh conversations", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({ create_temporary_chat: { cwd: "/tmp/bugs3-fresh", sessionId: "bugs3-fresh" }, start_pi: {}, stop_pi: {}, list_sessions: [], load_app_settings: settings, ...connectedSessionResponses(""), "pi_command:set_model": {}, start_terminal: {}, resize_terminal: {} });
    try {
      await $('button[aria-label="New conversation"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ command }) => command === "create_temporary_chat").length === 1);
      await app.prepareMessage("First fresh draft");
      await app.openTerminalButton.click();
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);

      await $('button[aria-label="New conversation"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ command }) => command === "create_temporary_chat").length === 2);

      await expect(app.composer).toHaveValue("");
      await expect(app.terminalPanel).not.toBeExisting();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(1);
    } finally {
      await resetBackend();
      await browser.refresh();
      await app.waitUntilReady();
    }
  });

  it("keeps a terminal tab when closing its process fails", async () => {
    await mockBackend({ start_terminal: {}, resize_terminal: {}, close_terminal: { error: "Terminal close failed" } });
    await app.openTerminalButton.click();
    await app.addTerminalButton.click();
    await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);

    await app.deleteTerminalButton.click();

    await expect($$(".terminal-tab")).toBeElementsArrayOfSize(2);
    await expect($(".error-toast strong")).toHaveText("Could not close terminal");
    await expect($(".error-toast span")).toHaveText("Terminal close failed");
  });

  it("reports a failed agent selection", async () => {
    await enableOrchestration();
    await mockBackend({ "pi_command:prompt": { error: "Agent switch failed" } });
    await $('button[aria-label="Agent"]').click();
    await $('//div[@role="listbox" and @aria-label="Agent options"]//button[.//span[normalize-space(.)="reviewer"]]').click();

    await expect($('button[aria-label="Agent"]')).toHaveText("default");
    await expect($(".error-toast strong")).toHaveText("Could not change agent");
    await expect($(".error-toast span")).toHaveText("Agent switch failed");
  });

  it("does not enable debug mode when persistence fails", async () => {
    const toggle = $('button[aria-label="Enable debug mode"], button[aria-label="Disable debug mode"]');
    const initialLabel = await toggle.getAttribute("aria-label");
    await mockBackend({ load_app_settings: defaultSettings, save_app_settings: { error: "Settings persistence failed" } });

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-label", initialLabel!);
    await expect($(".error-toast strong")).toHaveText("Could not change debug mode");
    await expect($(".error-toast span")).toHaveText("Settings persistence failed");
  });
});
const installedOrchestration = (): OrchestrationCapability => {
  const config = JSON.parse(readFileSync(installedOrchestrationConfigPath, "utf8")) as Partial<OrchestrationConfig>;
  const agents = config.agents ?? [];
  return {
    version: 1,
    active: agents.some((agent) => agent.name === "default") ? "default" : agents[0]?.name ?? "default",
    currentAgent: agents.some((agent) => agent.name === "default") ? "default" : agents[0]?.name,
    config: {
      agents,
      sequences: config.sequences ?? [],
    },
  };
};
const enableOrchestration = async (capability = acceptanceOrchestration()) => emitPiEvent({
  type: "extension_ui_request",
  id: "acceptance-orchestration",
  method: "setStatus",
  statusKey: "pi-desktop-orchestration",
  statusText: `json:${encodeOrchestrationValue(capability)}`,
});
const setSelectValue = (selector: string, value: string) => browser.execute((target, next) => {
  const select = document.querySelector<HTMLSelectElement>(target)!; select.value = next; select.dispatchEvent(new Event("change", { bubbles: true }));
}, selector, value);
const pressShortcut = (shortcut: string) => browser.execute((value) => {
  const parts = value.split("+"); const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase()); const key = value.endsWith("+") ? "+" : parts.at(-1) === "Space" ? " " : parts.at(-1)!;
  const mod = modifiers.includes("mod"); const mac = navigator.platform.toLowerCase().includes("mac");
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: modifiers.includes("ctrl") || (mod && !mac), metaKey: modifiers.includes("meta") || (mod && mac), altKey: modifiers.includes("alt"), shiftKey: modifiers.includes("shift"), bubbles: true }));
}, shortcut);
const connectedSessionResponses = (sessionId: string) => ({
  "pi_command:get_state": { model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 },
  "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:get_available_models": { models: [{ provider: "e2e", id: "acceptance", name: "Acceptance model" }, { provider: "e2e", id: "alternate", name: "Alternate model" }] },
  "pi_command:get_available_thinking_levels": { levels: ["off", "high"] }, "pi_command:get_commands": { commands: [] }, "pi_command:get_session_stats": {},
  "pi_command:set_auto_compaction": {}, "pi_command:set_auto_retry": {},
});
const startTemporaryConversation = async (responses: Record<string, unknown>) => {
  await mockBackend({
    create_temporary_chat: { cwd: "/tmp/acceptance-terminal", sessionId: "acceptance-terminal" },
    start_pi: {}, stop_pi: {}, list_sessions: [],
    load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance" },
    ...connectedSessionResponses("acceptance-terminal"),
    "pi_command:set_model": {},
    ...responses,
  });
  await $('button[aria-label="New conversation"]').click();
  await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "create_temporary_chat"));
  await app.composer.waitForEnabled();
};

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
    await expect(app.attachFilesButton).toBeClickable();
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
    const draft = "Explain how this project starts a Pi session";
    await app.prepareMessage(draft);

    await expect(app.sendMessageButton).toBeClickable();
    await app.openSettings();
    await expect(app.settingsHeading).toHaveText("Settings");

    await app.openConversations();
    await expect(app.composer).toHaveValue(draft);
    await expect(app.sendMessageButton).toBeClickable();
  });

  it("preserves the draft when the user opens and cancels the project chooser", async () => {
    const draft = "Review this workspace";
    await app.prepareMessage(draft);
    await app.openProjectChooser();

    await expect(app.projectDialogHeading).toHaveText("Open project");
    await expect(app.projectDirectory).toBeDisplayed();
    await app.cancelProjectButton.click();

    await expect(app.projectDialogHeading).not.toBeExisting();
    await expect(app.composer).toHaveValue(draft);
  });

  it("explains that a project path is required", async () => {
    await app.openProjectChooser();
    await app.chooseDirectoryButton.waitForEnabled();
    await app.projectDirectory.clearValue();
    await app.openProjectButton.click();

    await expect(app.dialogAlert).toHaveText("Path can't be empty");
    await app.cancelProjectButton.click();
  });

  it("opens settings from the keyboard", async () => {
    await browser.keys(["Control", ","]);
    await expect(app.settingsHeading).toHaveText("Settings");
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
      expect(await browser.execute(() => document.activeElement?.getAttribute("aria-label"))).toBe("Message Pi");
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
      await expect(menu.$$("[role='menuitem']")).toBeElementsArrayOfSize(4);
      await expect(session.$('button[aria-label="Archive conversation"]')).toBeExisting();
      await browser.keys("Escape");
      await expect(menu).not.toBeExisting();
    } finally {
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("collapses and restores a project's conversation group", async () => {
    const indexed = { id: "acceptance-collapse", path: "/tmp/acceptance-collapse.jsonl", name: "Acceptance grouped conversation", project: "Collapsible project", cwd: "/tmp", preview: "Grouped preview", messageCount: 1, hostId: "local" };
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

      await expect($("#extension-dialog-title")).toHaveText("Locate conversation project");
      const replacement = $('input[aria-label="Replacement project directory"]');
      await replacement.clearValue();
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();
      await expect($('[role="alert"]')).toHaveText("Path can't be empty");

      await replacement.setValue("/tmp/relocated-acceptance-project");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "relocate_session") && (await backendCalls()).some(({ command }) => command === "start_pi"));
      expect((await backendCalls()).find(({ command }) => command === "relocate_session")?.args).toEqual({ sessionPath: indexed.path, cwd: "/tmp/relocated-acceptance-project", hostId: "local" });
      expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/relocated-acceptance-project", sessionPath: indexed.path, hostId: "local" }));
    } finally {
      await app.conversationSearch.clearValue();
      if (await $("#extension-dialog-title").isExisting()) await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();
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
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();

      await expect($(".error-toast strong")).toHaveText("Pi could not connect");
      await expect($(".error-toast span")).toHaveText("Replacement directory is not a project");
      expect((await backendCalls()).find(({ command }) => command === "relocate_session")?.args).toEqual({ sessionPath: indexed.path, cwd: "/tmp/not-a-project", hostId: "local" });
      await $(".error-toast button").click();
    } finally {
      await app.conversationSearch.clearValue();
      if (await $("#extension-dialog-title").isExisting()) await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();
      if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("archives an indexed conversation through its visible action", async () => {
    const indexed = { id: "acceptance-archive", path: "/tmp/acceptance-archive.jsonl", name: "Acceptance archive target", project: "Acceptance project", cwd: "/tmp", preview: "Archive preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], archive_session: {} });
    try {
      await app.conversationSearch.setValue("Acceptance archive target");
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await session.$('button[aria-label="Archive conversation"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "archive_session"));
      expect((await backendCalls()).find(({ command }) => command === "archive_session")?.args).toEqual({ sessionPath: indexed.path, hostId: "local", terminalState: undefined });
    } finally {
      await app.conversationSearch.clearValue();
      await resetApp();
    }
  });

  it("keeps a conversation available when archiving fails", async () => {
    const indexed = { id: "acceptance-archive-failure", path: "/tmp/acceptance-archive-failure.jsonl", name: "Acceptance archive failure", project: "Acceptance project", cwd: "/tmp", preview: "Archive failure preview", messageCount: 2, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], archive_session: { error: "Archive destination is unavailable" } });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await session.$('button[aria-label="Archive conversation"]').click();

      await expect($(".error-toast strong")).toHaveText("Could not archive conversation");
      await expect($(".error-toast span")).toHaveText("Archive destination is unavailable");
      await expect(session).toBeDisplayed();
      await $(".error-toast button").click();
    } finally {
      await app.conversationSearch.clearValue();
      if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("opens an indexed conversation as a second chat shell and closes it by selecting that session", async () => {
    const indexed = { id: "acceptance-split", path: "/tmp/acceptance-split.jsonl", name: "Acceptance split target", project: "Acceptance project", cwd: "/tmp", preview: "Split preview", messageCount: 1, hostId: "local" };
    await mockBackend({ list_sessions: [indexed], start_pi: {}, stop_pi: {}, ...connectedSessionResponses(indexed.id) });
    try {
      await app.conversationSearch.setValue(indexed.name);
      const session = $(".session-item");
      await expect(session).toHaveText(expect.stringContaining(indexed.name));
      await browser.execute(() => document.querySelector(".session-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
      await $('//div[@role="menu"]//button[normalize-space(.)="Split pane"]').click();

      const split = $(`section[aria-label="Split conversation: ${indexed.name}"]`);
      await expect(split).toBeDisplayed();
      await expect($$(".chat-panes .chat-shell")).toBeElementsArrayOfSize(2);
      await session.$(".session-main").click();
      await expect(split).not.toBeExisting();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "stop_pi"));
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
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "set_session_name"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "set_session_name")?.args.command).toEqual({ type: "set_session_name", name: "Renamed acceptance conversation" });
    } finally {
      await app.conversationSearch.clearValue();
      await resetApp();
    }
  });

  it("opens, adds, deletes, and closes an ephemeral terminal", async () => {
    await mockBackend({ start_terminal: {}, resize_terminal: {}, close_terminal: {} });
    try {
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeDisplayed();
      const before = await $$(".terminal-tab");
      await app.addTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(before.length + 1);

      await app.deleteTerminalButton.click();
      await expect($$(".terminal-tab")).toBeElementsArrayOfSize(before.length);
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "close_terminal"));
      expect((await backendCalls()).find(({ command }) => command === "close_terminal")?.mocked).toBe(true);
      await app.closeTerminalButton.click();
      await expect(app.terminalPanel).not.toBeExisting();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
      await resetBackend();
    }
  });

  it("sends the composed prompt to Pi and clears the accepted draft", async () => {
    await mockBackend({ "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:fork": {}, "pi_command:prompt": {} });
    try {
      await app.prepareMessage("Explain the failing build");
      await app.sendMessageButton.click();

      await expect(app.composer).toHaveValue("");
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      const prompt = (await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt");
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
      await browser.execute(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pi"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
      await expect(app.composer).toHaveValue("First line");
      expect((await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "prompt")).toHaveLength(0);
      await app.composer.setValue("First line\nSecond line");
      expect((await app.composer.getValue()).replaceAll("\r\n", "\n")).toBe("First line\nSecond line");

      await app.composer.setValue("Submit this with Enter");
      await browser.keys("Enter");
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt")?.args.command).toEqual({ type: "prompt", message: "Submit this with Enter" });
      await expect(app.composer).toHaveValue("");
    } finally {
      await resetBackend();
    }
  });

  it("discovers and selects a slash command supplied by Pi", async () => {
    await mockBackend({ ...connectedSessionResponses("command-session"), "pi_command:get_commands": { commands: [{ name: "review", description: "Review the current changes", source: "extension", sourceInfo: { source: "acceptance" } }] } });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("/rev");
      const palette = $('[role="listbox"][aria-label="Pi commands"]');
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
      "pi_command:get_commands": { commands: [
        { name: "review", description: "Visible review command", source: "extension", sourceInfo: { source: "acceptance" } },
        { name: "internal-inline", description: "Inline-only command", source: "extension", sourceInfo: { source: "inline" } },
        { name: "pi-orchestration-next", description: "Internal orchestration command", source: "extension", sourceInfo: { source: "acceptance" } },
      ] },
    });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("/");
      const palette = $('[role="listbox"][aria-label="Pi commands"]');
      await expect(palette).toHaveText(expect.stringContaining("/review"));
      const text = await palette.getText();
      expect(text).not.toContain("internal-inline");
      expect(text).not.toContain("pi-orchestration-next");
      await expect(palette.$$('[role="option"]')).toBeElementsArrayOfSize(2);
      await expect(palette).toHaveText(expect.stringContaining("/compact"));
    } finally {
      await app.clearMessage();
      await resetBackend();
    }
  });

  it("forks and retries the latest aborted response", async () => {
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

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      expect((await backendCalls()).filter(({ args }) => ["fork", "prompt"].includes(String((args.command as { type?: string })?.type))).map(({ args }) => args.command)).toEqual([
        { type: "fork", entryId: "retry-user" }, { type: "prompt", message: "Retry this acceptance request" },
      ]);
      expect((await backendCalls()).find(({ command }) => command === "delete_session")?.args).toEqual({ sessionPath: "/tmp/retry-session.jsonl", hostId: "local" });
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
        const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
        const transfer = new DataTransfer(); transfer.items.add(new File(["Acceptance fixture content."], "acceptance-note.txt", { type: "text/plain" }));
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining("acceptance-note.txt"));
      await app.prepareMessage("Summarize the attachment");
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      const prompt = (await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt");
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
        const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
        const transfer = new DataTransfer(); transfer.items.add(new File(["Quoted filename content"], 'report "draft".txt', { type: "text/plain" }));
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining('report "draft".txt'));
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt")?.args.command).toEqual({ type: "prompt", message: '<file name="report &quot;draft&quot;.txt">\nQuoted filename content\n</file>' });
    } finally {
      await resetBackend();
    }
  });

  it("limits a single composer to twelve attachments", async () => {
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
      const transfer = new DataTransfer();
      for (let index = 1; index <= 13; index += 1) transfer.items.add(new File([`fixture ${index}`], `fixture-${index}.txt`, { type: "text/plain", lastModified: index }));
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect($$(".attachments > span")).toBeElementsArrayOfSize(12);
    await expect($(".attachments")).toHaveText(expect.stringContaining("fixture-12.txt"));
    expect(await $(".attachments").getText()).not.toContain("fixture-13.txt");

    while ((await $$(".attachments button")).length) await $(".attachments button").click();
    await expect($(".attachments")).not.toBeExisting();
  });

  it("removes an attachment before it can be submitted", async () => {
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
      const transfer = new DataTransfer(); transfer.items.add(new File(["Do not send this fixture."], "discard-me.txt", { type: "text/plain" }));
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect($(".attachments")).toHaveText(expect.stringContaining("discard-me.txt"));

    await $('button[aria-label="Remove discard-me.txt"]').click();
    await expect($(".attachments")).not.toBeExisting();
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("rejects a text attachment larger than 200 KB", async () => {
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(200_001)], "too-large.txt", { type: "text/plain" }));
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect($(".upload-error")).toHaveText("too-large.txt is larger than 200 KB");
    await expect($(".attachments")).not.toBeExisting();
    await expect(app.sendMessageButton).toBeDisabled();
  });

  it("submits an attached image with its encoded payload", async () => {
    await mockBackend({ "pi_command:get_entries": { entries: [], leafId: null }, "pi_command:fork": {}, "pi_command:prompt": {} });
    try {
      await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files }); input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect($(".attachments")).toHaveText(expect.stringContaining("pixel.png"));
      await app.sendMessageButton.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
      const command = (await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt")?.args.command as { message: string; images: Array<{ data: string; mimeType: string; name: string }> };
      expect(command.message).toBe("Describe the attached image.");
      expect(command.images).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png", name: "pixel.png" }]);
    } finally {
      await resetBackend();
    }
  });

  it("renders live assistant activity delivered through Tauri events", async () => {
    await emitPiEvent({ type: "agent_start" });
    await expect($(".stream-banner")).toHaveText(expect.stringContaining("Pi is working"));
    await expect($('button[aria-label="Stop Pi"]')).toBeDisplayed();

    await emitPiEvent({ type: "message_start", message: { id: "acceptance-stream", role: "assistant", content: "Streaming acceptance response" } });
    await expect($(".assistant-message")).toHaveText(expect.stringContaining("Streaming acceptance response"));
    await expect($(".stream-caret")).toBeDisplayed();

    await emitPiEvent({ type: "agent_end" });
    await expect($(".stream-banner")).not.toBeExisting();
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
      await expect($('button[aria-label="Copy response"]')).toBeDisplayed();
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

  it("shows visible sequence outputs and omits synthetic or background-only prompts", async () => {
    const hiddenMarker = `<!-- pi-desktop-sequence:${encodeURIComponent(JSON.stringify({ sequence: "release-flow", step: 1, agent: "builder", visible: false }))} -->\n`;
    const visibleMarker = `<!-- pi-desktop-sequence:${encodeURIComponent(JSON.stringify({ sequence: "release-flow", step: 2, agent: "reviewer", visible: true }))} -->\n`;
    const history = {
      entries: [
        { type: "message", id: "sequence-hidden-user", parentId: null, message: { role: "user", content: `${hiddenMarker}Background implementation`, timestamp: 1 } },
        { type: "message", id: "sequence-hidden-answer", parentId: "sequence-hidden-user", message: { role: "assistant", content: "Hidden builder answer", timestamp: 2 } },
        { type: "message", id: "sequence-visible-user", parentId: "sequence-hidden-answer", message: { role: "user", content: `${visibleMarker}Review the implementation`, timestamp: 3 } },
        { type: "message", id: "sequence-visible-answer", parentId: "sequence-visible-user", message: { role: "assistant", content: "Visible reviewer answer", timestamp: 4 } },
      ],
      leafId: "sequence-visible-answer",
    };
    await mockBackend({ ...connectedSessionResponses("sequence-display-session"), "pi_command:get_entries": history });
    try {
      await emitPiEvent({ type: "session_switched" });
      await expect($(".sequence-step-label")).toHaveText("release-flow · reviewer");
      await expect($(".user-message")).not.toBeExisting();
      await expect($('//article[contains(@class,"assistant-message")][contains(.,"Visible reviewer answer")]')).toBeDisplayed();
      const conversation = await $(".conversation").getText();
      expect(conversation).not.toContain("Review the implementation");
      expect(conversation).not.toContain("Background implementation");
      expect(conversation).not.toContain("Hidden builder answer");
      expect(conversation).not.toContain("pi-desktop-sequence");
    } finally {
      await resetBackend();
    }
  });

  it("renders a tool call from running through completion", async () => {
    await emitPiEvent({ type: "tool_execution_start", toolCallId: "acceptance-tool", toolName: "acceptance_tool", args: { path: "README.md" } });
    const tool = $('//details[contains(@class,"tool-event")][.//strong[contains(.,"acceptance_tool")]]');
    await expect(tool).toHaveText(expect.stringContaining("Running…"));

    await emitPiEvent({ type: "tool_execution_update", toolCallId: "acceptance-tool", partialResult: { content: "Reading…" } });
    await emitPiEvent({ type: "tool_execution_end", toolCallId: "acceptance-tool", result: { content: "Tool finished" }, isError: false });
    await expect(tool).toHaveText(expect.stringContaining("Completed"));
    await tool.$("summary").click();
    await expect(tool.$("pre")).toHaveText("Tool finished");
  });

  it("renders a failed tool with its diagnostic output", async () => {
    await emitPiEvent({ type: "tool_execution_start", toolCallId: "acceptance-failed-tool", toolName: "write", args: { path: "protected.txt" } });
    await emitPiEvent({ type: "tool_execution_end", toolCallId: "acceptance-failed-tool", result: { content: "Permission denied" }, isError: true });

    const tool = $('//details[contains(@class,"tool-event")][.//strong[contains(.,"write")]]');
    await expect(tool).toHaveText(expect.stringContaining("Failed"));
    await tool.$("summary").click();
    await expect(tool.$("pre")).toHaveText("Permission denied");
  });

  it("labels delegated agent tool calls by their target", async () => {
    await emitPiEvent({ type: "tool_execution_start", toolCallId: "acceptance-agent-call", toolName: "call_agent", args: { target: "reviewer", message: "Review this" } });
    const tool = $('//details[contains(@class,"tool-event")][.//strong[contains(.,"reviewer called")]]');
    await expect(tool).toHaveText(expect.stringContaining("Running…"));
    await emitPiEvent({ type: "tool_execution_end", toolCallId: "acceptance-agent-call", result: { content: "Review complete" }, isError: false });
    await expect(tool).toHaveText(expect.stringContaining("Completed"));
  });

  it("tracks queued steering and follow-up messages from backend events", async () => {
    try {
      await emitPiEvent({ type: "agent_start" });
      await emitPiEvent({ type: "queue_update", steering: [{}, {}], followUp: [{}] });
      await expect($(".stream-banner")).toHaveText(expect.stringContaining("3 queued"));

      await emitPiEvent({ type: "queue_update", steering: [], followUp: [] });
      await browser.waitUntil(async () => !(await $(".stream-banner").getText()).includes("queued"));
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [] });
      await emitPiEvent({ type: "agent_end" });
    }
  });

  it("updates the thinking selector when Pi changes effort", async () => {
    await mockBackend(connectedSessionResponses("thinking-event-session"));
    try {
      await emitPiEvent({ type: "session_switched" });
      await expect(app.thinkingLevelPicker).toHaveText("high");
      await emitPiEvent({ type: "thinking_level_changed", level: "off" });
      await expect(app.thinkingLevelPicker).toHaveText("off");
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

      await emitPiEvent({ type: "compaction_end", result: { estimatedTokensAfter: 18_000 } });
      await browser.waitUntil(async () => (await wheel.getAttribute("aria-label"))?.startsWith("18%") === true);
      expect((await wheel.getAttribute("aria-label"))?.replaceAll(",", "")).toBe("18% of 100000 context tokens used");
    } finally {
      await resetBackend();
    }
  });

  it("shows cache reuse for both a response and the whole session", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", debugMode: true };
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
      await expect($(".cache-hit-rate")).toHaveText("Cache 75%");
      expect((await $(".cache-hit-rate").getAttribute("title"))?.replaceAll(",", "")).toBe("3000 of 4000 prompt tokens read from cache");
      await expect($(".session-cache-hit")).toHaveText("Cache 75%");
      expect((await $(".session-cache-hit").getAttribute("title"))?.replaceAll(",", "")).toBe("3000 of 4000 session prompt tokens read from cache");
    } finally {
      await resetBackend();
      await browser.refresh();
      await app.waitUntilReady();
    }
  });

  it("renders terminal output and reports when the process exits", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({ create_temporary_chat: { cwd: "/tmp/terminal-output", sessionId: "terminal-output" }, list_sessions: [], ...connectedSessionResponses(""), "pi_command:set_model": {}, load_app_settings: settings, start_pi: {}, stop_pi: {}, start_terminal: {}, resize_terminal: {}, close_terminal: {} });
    try {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await $('button[aria-label="New conversation"]').click();
      await expect(app.openTerminalButton).toBeEnabled();
      await app.openTerminalButton.click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "start_terminal"));
      const terminalId = (await backendCalls()).find(({ command }) => command === "start_terminal")?.args.terminalId as string;

      await emitPiEvent({ type: "terminal_output", terminalId, data: "acceptance terminal output\r\n" });
      await browser.waitUntil(async () => String(await browser.execute(() => document.querySelector(".xterm-rows")?.textContent)).includes("acceptance terminal output"));
      await emitPiEvent({ type: "terminal_exit", terminalId });
      await expect($(".terminal-exited")).toHaveText("exited");

      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeExisting();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.deleteTerminalButton.click();
      await resetBackend();
      await browser.refresh();
      await app.waitUntilReady();
    }
  });

  it("shows a terminal startup failure inside the terminal", async () => {
    await resetApp();
    await startTemporaryConversation({ start_terminal: { error: "Terminal launch rejected" }, resize_terminal: {}, close_terminal: {} });
    try {
      await app.openTerminalButton.click();
      await browser.waitUntil(async () => String(await browser.execute(() => document.querySelector(".xterm-rows")?.textContent)).includes("Could not start terminal: Error: Terminal launch rejected"));
      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeExisting();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.deleteTerminalButton.click();
      await resetBackend();
    }
  });

  it("shows terminal input failures inside the active terminal", async () => {
    await resetApp();
    await startTemporaryConversation({ start_terminal: {}, resize_terminal: {}, write_terminal: { error: "Terminal input channel closed" }, close_terminal: {} });
    try {
      await app.openTerminalButton.click();
      await expect(app.terminalPanel).toBeDisplayed();
      await browser.keys("x");
      await browser.waitUntil(async () => String(await browser.execute(() => document.querySelector(".xterm-rows")?.textContent)).includes("Terminal input failed: Error: Terminal input channel closed"));
      await app.deleteTerminalButton.click();
      await expect(app.terminalPanel).not.toBeExisting();
    } finally {
      if (await app.terminalPanel.isExisting()) await app.deleteTerminalButton.click();
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
      await browser.execute(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { __e2eClipboard?: string }).__e2eClipboard = text; } } }));
      await emitPiEvent({ type: "session_switched" });
      await expect($(".assistant-message")).toHaveText(expect.stringContaining("const answer = 42;"));

      await $('button[aria-label="Copy response"]').click();
      expect(await browser.execute(() => (window as unknown as { __e2eClipboard?: string }).__e2eClipboard)).toBe(response);
      await $('button[aria-label="Copy code"]').click();
      await expect($('button[aria-label="Code copied"]')).toBeDisplayed();
      expect(await browser.execute(() => (window as unknown as { __e2eClipboard?: string }).__e2eClipboard)).toBe("const answer = 42;");
    } finally {
      await resetBackend();
    }
  });

  it("presents skill references and compacts repeated intermediate work", async () => {
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
    await mockBackend({ ...connectedSessionResponses("branch-session"), "pi_command:get_entries": history, "pi_command:fork": {} });
    try {
      await emitPiEvent({ type: "session_switched" });
      const branch = $('button[aria-label="Branch from here"]');
      await branch.waitForClickable();
      await branch.click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "fork"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "fork")?.args.command).toEqual({ type: "fork", entryId: "branch-user" });
    } finally {
      await resetBackend();
    }
  });

  it("steers a live response immediately", async () => {
    await mockBackend({ "pi_command:steer": {} });
    try {
      await emitPiEvent({ type: "agent_start" });
      await expect($('select[aria-label="Streaming message behavior"]')).toHaveValue("steer");
      await app.prepareMessage("Focus on the acceptance criteria");
      await $('button[aria-label="Send steering message"]').click();

      await expect(app.composer).toHaveValue("");
      await expect($(".stream-banner")).toHaveText(expect.stringContaining("1 queued"));
      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "steer"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "steer")?.args.command).toEqual({ type: "steer", message: "Focus on the acceptance criteria" });
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [] });
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("queues a follow-up and can stop a streaming response", async () => {
    await mockBackend({ "pi_command:follow_up": {}, "pi_command:abort": {} });
    try {
      await emitPiEvent({ type: "agent_start" });
      const behavior = $('select[aria-label="Streaming message behavior"]');
      await browser.execute(() => { const select = document.querySelector<HTMLSelectElement>('select[aria-label="Streaming message behavior"]')!; select.value = "followUp"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      await expect(behavior).toHaveValue("followUp");
      await app.prepareMessage("Check this after the current response");
      await $(".composer-actions .send").click();

      await expect($(".stream-banner")).toHaveText(expect.stringContaining("1 queued"));
      await $('button[aria-label="Stop Pi"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => ["follow_up", "abort"].includes(String((args.command as { type?: string })?.type))).length === 2);
      expect((await backendCalls()).filter(({ args }) => ["follow_up", "abort"].includes(String((args.command as { type?: string })?.type))).map(({ args }) => args.command)).toEqual([
        { type: "follow_up", message: "Check this after the current response" }, { type: "abort" },
      ]);
    } finally {
      await emitPiEvent({ type: "queue_update", steering: [], followUp: [] });
      await emitPiEvent({ type: "agent_end" });
      await resetBackend();
    }
  });

  it("returns extension input through the Pi event bridge", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-input", method: "input", title: "Choose a release name", placeholder: "Release name", prefill: "alpha" });
      const input = $('input[aria-label="Release name"]');
      await expect(input).toHaveValue("alpha");
      await input.setValue("beta");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response"));
      expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response")?.args.command).toEqual({ type: "extension_ui_response", id: "acceptance-input", value: "beta" });
      await expect($("#extension-dialog-title")).not.toBeExisting();
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
      await expect($("#extension-dialog-title")).not.toBeExisting();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-no-confirm", method: "confirm", title: "Publish release?" });
      await $('//section[@role="dialog"]//button[normalize-space(.)="No"]').click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response").length === 2);
      expect((await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response").map(({ args }) => args.command)).toEqual([
        { type: "extension_ui_response", id: "acceptance-enter-input", value: "beta" },
        { type: "extension_ui_response", id: "acceptance-no-confirm", confirmed: false },
      ]);
    } finally {
      await resetBackend();
    }
  });

  it("returns multiline extension editor content", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor-content", method: "editor", title: "Release notes", placeholder: "Release notes", prefill: "Initial line" });
      const editor = $('textarea[aria-label="Release notes"]');
      await editor.setValue("First line\nSecond line");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();

      await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "acceptance-editor-content"));
      expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "acceptance-editor-content")?.args.command).toEqual({ type: "extension_ui_response", id: "acceptance-editor-content", value: "First line\nSecond line" });
    } finally {
      await resetBackend();
    }
  });

  it("supports extension selection, confirmation, and cancellation", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-select", method: "select", title: "Choose a target", options: ["Alpha", "Beta"] });
      await $('//section[@role="dialog"]//button[normalize-space(.)="Beta"]').click();
      await expect($("#extension-dialog-title")).not.toBeExisting();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-confirm", method: "confirm", title: "Deploy now?", message: "This will deploy the acceptance build." });
      await expect($("#extension-dialog-title")).toHaveText("Deploy now?");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Confirm"]').click();

      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor", method: "editor", title: "Edit release notes", prefill: "Initial notes" });
      await expect($('textarea[aria-label="Edit release notes"]')).toHaveValue("Initial notes");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();

      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response").length === 3);
      expect((await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "extension_ui_response").map(({ args }) => args.command)).toEqual([
        { type: "extension_ui_response", id: "acceptance-select", value: "Beta" },
        { type: "extension_ui_response", id: "acceptance-confirm", confirmed: true },
        { type: "extension_ui_response", id: "acceptance-editor", cancelled: true },
      ]);
    } finally {
      await resetBackend();
    }
  });

  it("shows and clears extension status, widgets, and notifications", async () => {
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-status", method: "setStatus", statusKey: "acceptance", statusText: "Indexing workspace" });
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-widget", method: "setWidget", widgetKey: "acceptance", widgetLines: ["3 files changed", "Tests pending"] });
    await expect($(".extension-status")).toHaveText("Indexing workspace");
    await expect($(".extension-widget")).toHaveText(expect.stringContaining("3 files changed"));

    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-notice", method: "notify", notifyType: "warning", message: "Review generated changes" });
    await expect($(".error-toast strong")).toHaveText("Extension warning");
    await expect($(".error-toast span")).toHaveText("Review generated changes");
    await $(".error-toast button").click();

    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-status-clear", method: "setStatus", statusKey: "acceptance", statusText: "" });
    await emitPiEvent({ type: "extension_ui_request", id: "acceptance-widget-clear", method: "setWidget", widgetKey: "acceptance" });
    await expect($(".extension-status")).not.toBeExisting();
    await expect($(".extension-widget")).not.toBeExisting();
  });

  it("surfaces actionable extension errors but ignores stale-context noise", async () => {
    await emitPiEvent({ type: "extension_error", error: "This extension ctx is stale after session replacement or reload. request ignored" });
    await expect($(".error-toast")).not.toBeExisting();

    await emitPiEvent({ type: "extension_error", error: "Acceptance extension failed to load" });
    await expect($(".error-toast strong")).toHaveText("Extension error");
    await expect($(".error-toast span")).toHaveText("Acceptance extension failed to load");
    await $(".error-toast button").click();
    await expect($(".error-toast")).not.toBeExisting();
  });

  it("applies extension-driven window titles and editor text", async () => {
    const originalTitle = await browser.getTitle();
    try {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-title", method: "setTitle", title: "Acceptance review in progress" });
      await browser.waitUntil(async () => await browser.getTitle() === "Acceptance review in progress");
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-editor-text", method: "set_editor_text", text: "Review the generated acceptance changes" });
      await expect(app.composer).toHaveValue("Review the generated acceptance changes");
      expect(await browser.execute(() => document.activeElement?.getAttribute("aria-label"))).toBe("Message Pi");
    } finally {
      await emitPiEvent({ type: "extension_ui_request", id: "acceptance-title-reset", method: "setTitle", title: originalTitle });
      await app.clearMessage();
    }
  });

  it("stacks simultaneous application and extension notices", async () => {
    await mockBackend({ save_app_settings: { error: "Settings write deliberately failed" } });
    const debug = $('button[aria-label$="debug mode"]');
    try {
      await debug.click();
      await emitPiEvent({ type: "extension_ui_request", id: "stacked-notice", method: "notify", notifyType: "warning", message: "Review generated changes" });
      const toasts = await $$(".error-toast");
      await expect(toasts).toBeElementsArrayOfSize(2);
      expect(await toasts[0].getLocation("y")).not.toBe(await toasts[1].getLocation("y"));
    } finally {
      await updateBackendResponse("save_app_settings", {});
      await debug.click();
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await resetBackend();
    }
  });

  it("queues extension dialogs behind the project picker", async () => {
    await mockBackend({ home_directory: "/tmp", "pi_command:extension_ui_response": {} });
    try {
      await app.openProjectChooser();
      await emitPiEvent({ type: "extension_ui_request", id: "queued-confirm", method: "confirm", title: "Confirm extension action" });
      await expect($$("[role='dialog']")).toBeElementsArrayOfSize(1);
      await expect(app.projectDialogHeading).toBeDisplayed();
      await app.cancelProjectButton.click();
      await expect($("#extension-dialog-title")).toHaveText("Confirm extension action");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectButton.click();
      if (await $("#extension-dialog-title").isExisting()) await $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]').click();
      await resetBackend();
    }
  });

  it("keeps extension input when sending its response fails", async () => {
    await mockBackend({ "pi_command:extension_ui_response": { error: "Extension response channel closed" } });
    try {
      await emitPiEvent({ type: "extension_ui_request", id: "failed-response", method: "input", title: "Required value", placeholder: "Label" });
      const input = $('input[aria-label="Label"]');
      await input.setValue("release-candidate");
      await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();
      await expect($(".dialog-error")).toHaveText("Extension response channel closed");
      await expect(input).toHaveValue("release-candidate");
    } finally {
      if (await $("#extension-dialog-title").isExisting()) {
        await updateBackendResponse("pi_command:extension_ui_response", {});
        await $('//section[@role="dialog"]//button[normalize-space(.)="Continue"]').click();
      }
      await resetBackend();
    }
  });

  it("uses Tab to complete the selected slash command without submitting", async () => {
    await mockBackend({ ...connectedSessionResponses("tab-command-session"), "pi_command:prompt": {} });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.prepareMessage("/");
      await expect($('[role="option"][aria-selected="true"]')).toHaveText(expect.stringContaining("/compact"));
      await browser.keys("Tab");
      expect((await app.composer.getValue()).trim()).toBe("/compact");
      expect((await backendCalls()).filter(({ args }) => (args.command as { type?: string })?.type === "prompt")).toHaveLength(0);
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
    await app.openProjectChooser();
    try {
      await pressShortcut(panelShortcut);
      await expect($(".session-panel")).toBeDisplayed();
      await expect(app.projectDialogHeading).toBeDisplayed();
    } finally {
      if (!(await $(".session-panel").isExisting())) await pressShortcut(panelShortcut);
      await app.cancelProjectButton.click();
    }
  });

});

describe("/btw acceptance", () => {
  const request = (id: string, payload: Record<string, unknown>) => emitPiEvent({
    type: "extension_ui_request",
    id,
    method: "input",
    title: "__pi_desktop_btw__",
    placeholder: JSON.stringify(payload),
  });
  const runtimeResponses = () => ({
    start_pi: {}, stop_pi: {}, ...connectedSessionResponses("btw-runtime"),
    "pi_command:prompt": {}, "pi_command:extension_ui_response": {},
  });

  before(async () => {
    await resetApp();
  });

  beforeEach(async () => {
    await app.openConversations();
  });

  afterEach(async () => {
    const split = $('section[aria-label="Split conversation: BTW"]');
    if (await split.isExisting()) await split.$('button[aria-label="Close split pane"]').click();
    if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
    await resetBackend();
  });

  it("opens a persistent forked side conversation", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-success", { task: "Review the changed API", sessionFile: "/tmp/source-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: BTW"]');
    await expect(split).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));
    expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/acceptance-btw", forkPath: "/tmp/source-session.jsonl", hostId: "local" }));
    expect((await backendCalls()).find(({ args }) => (args.command as { type?: string })?.type === "prompt")?.args.command).toEqual({ type: "prompt", message: "Review the changed API" });

    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string; type?: string })?.id === "btw-success"));
    expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "btw-success")?.args.command).toEqual({ type: "extension_ui_response", id: "btw-success", value: "opened" });

    await emitPiEvent({ type: "agent_settled" });
    await expect(split).toBeDisplayed();
  });

  it("closes an opened side conversation without cancelling its acknowledged request", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-cancel", { task: "Investigate separately", sessionFile: "/tmp/source-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: BTW"]');
    await expect(split).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "btw-cancel"));
    await split.$('button[aria-label="Close split pane"]').click();
    await expect(split).not.toBeExisting();
    const responses = (await backendCalls()).filter(({ args }) => (args.command as { id?: string })?.id === "btw-cancel");
    expect(responses).toHaveLength(1);
    expect(responses[0].args.command).toEqual({ type: "extension_ui_response", id: "btw-cancel", value: "opened" });
    await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "stop_pi"));
  });

  it("rejects a malformed side-conversation request", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    await request("btw-invalid", { task: "", cwd: "/tmp/acceptance-btw" });

    await expect($('section[aria-label="Split conversation: BTW"]')).not.toBeExisting();
    await expect($(".error-toast strong")).toHaveText("Could not start /btw");
    await expect($(".error-toast span")).toHaveText("Invalid /btw branch request");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "btw-invalid"));
    expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "btw-invalid")?.args.command).toEqual({ type: "extension_ui_response", id: "btw-invalid", cancelled: true });
  });

  it("reports when the forked runtime cannot start", async () => {
    await mockBackend({ ...runtimeResponses(), start_pi: { error: "Fork runtime unavailable" } });
    await request("btw-start-failure", { task: "Review separately", sessionFile: "/tmp/source-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: BTW"]');
    await expect(split).toBeDisplayed();
    await expect(split.$(".split-pane-status.error")).toHaveText("Fork runtime unavailable");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "btw-start-failure"));
    expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "btw-start-failure")?.args.command).toEqual({ type: "extension_ui_response", id: "btw-start-failure", cancelled: true });
  });

  it("keeps a settled side conversation open when it has no answer", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-no-answer", { task: "Find an answer", sessionFile: "/tmp/source-session.jsonl", cwd: "/tmp/acceptance-btw" });
    await expect($('section[aria-label="Split conversation: BTW"]')).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "prompt"));

    await emitPiEvent({ type: "agent_settled" });
    await expect($('section[aria-label="Split conversation: BTW"]')).toBeDisplayed();
    await expect($(".error-toast")).not.toBeExisting();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "btw-no-answer"));
    expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "btw-no-answer")?.args.command).toEqual({ type: "extension_ui_response", id: "btw-no-answer", value: "opened" });
  });
});

describe("Settings behavior", () => {
  before(async () => {
    await resetApp();
  });

  it("keeps edited settings and explains when the backend rejects saving", async () => {
    await mockBackend({ save_app_settings: { error: "Settings disk is read-only" } });
    try {
      await app.openSettings();
      const initialValue = await app.automaticRetryToggle.getAttribute("aria-checked");
      await app.automaticRetryToggle.click();
      await app.saveSettingsButton.click();

      await expect($(".settings-save [role='alert']")).toHaveText("Settings disk is read-only");
      await expect(app.automaticRetryToggle).toHaveAttribute("aria-checked", initialValue === "true" ? "false" : "true");
      expect((await backendCalls()).filter(({ command }) => command === "save_app_settings")).toHaveLength(1);
    } finally {
      await resetBackend();
      await app.openConversations();
    }
  });
});

describe("Orchestration acceptance", () => {
  before(async () => {
    await resetApp();
  });

  beforeEach(async () => {
    await app.openConversations();
    await enableOrchestration();
  });

  afterEach(async () => {
    if (await app.settingsHeading.isExisting()) await app.openConversations();
    await resetBackend();
  });

  it("reveals agent and sequence controls when the extension advertises them", async () => {
    await expect(app.agentPicker).toHaveText("default");
    await app.agentPicker.click();
    const agents = $('[role="listbox"][aria-label="Agent options"]');
    await expect(agents).toHaveText(expect.stringContaining("reviewer"));
    await expect(agents).toHaveText(expect.stringContaining("final-only"));
    await browser.keys("Escape");

    await app.openSettings();
    await expect(app.settingsSection("Agents")).toBeDisplayed();
    await expect(app.settingsSection("Sequences")).toBeDisplayed();
  });

  it("selects an agent by sending the orchestration use command", async () => {
    await mockBackend({ "pi_command:prompt": {} });
    await app.chooseComposerOption("Agent", "reviewer");

    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => String((args.command as { message?: string })?.message).startsWith("/pi-orchestration-use ")));
    const message = ((await backendCalls()).find(({ args }) => String((args.command as { message?: string })?.message).startsWith("/pi-orchestration-use "))?.args.command as { message: string }).message;
    expect(decodeOrchestrationValue<string>(message.slice("/pi-orchestration-use ".length))).toBe("reviewer");
  });

  it("creates an agent with inherited resources and editable instructions", async () => {
    await app.openSettings();
    const inheritedEffort = await $('//label[contains(@class,"field")][span[normalize-space(.)="Thinking level"]]/select').getValue();
    await app.openSettingsSection("Agents");
    await $('//button[normalize-space(.)="Add agent"]').click();

    const name = $('input[aria-label="Agent name"]');
    await expect(name).toHaveValue("agent-2");
    await name.setValue("acceptance-agent");
    await $('input[aria-label="Agent description"]').setValue("Handles acceptance checks");
    await $('textarea[aria-label="System prompt"]').setValue("Verify observable behavior.");
    await expect($('select[aria-label="Agent default effort"]')).toHaveValue(inheritedEffort);
    await expect($('input[aria-label="Allow read"]')).toBeSelected();
    await expect($('input[aria-label="Allow bash"]')).toBeSelected();

    await $('input[aria-label="Allow bash"]').click();
    await expect($('input[aria-label="Allow bash"]')).not.toBeSelected();
    await expect($('input[aria-label="Agent description"]')).toHaveValue("Handles acceptance checks");
    await expect($('textarea[aria-label="System prompt"]')).toHaveValue("Verify observable behavior.");
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

  it("updates sequence steps when an agent is renamed", async () => {
    const capability = acceptanceOrchestration();
    capability.config.sequences = [{ name: "review-flow", description: "Review changes", agents: ["default", "reviewer"], visibleSteps: 2 }];
    await enableOrchestration(capability);
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent name"]').setValue("auditor");

    await app.openSettingsSection("Sequences");
    await expect($('select[aria-label="Sequence step 2"]')).toHaveValue("auditor");
    await expect($('select[aria-label="Sequence step 2"]')).toHaveText(expect.stringContaining("auditor"));
    expect(await $('select[aria-label="Sequence step 2"]').getText()).not.toContain("reviewer");
  });

  it("removes sequences that depend on a deleted agent", async () => {
    const capability = acceptanceOrchestration();
    capability.config.sequences = [{ name: "review-flow", description: "Review changes", agents: ["default", "reviewer"], visibleSteps: 2 }];
    await enableOrchestration(capability);
    await app.openSettings();
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('button[aria-label="Remove reviewer"]').click();

    await app.openSettingsSection("Sequences");
    await expect($(".sequence-editor .empty-small")).toHaveText("Add a sequence to get started.");
  });

  it("builds a multi-step sequence and controls how many steps are visible", async () => {
    await app.openSettings();
    await app.openSettingsSection("Sequences");
    await $('//button[normalize-space(.)="Add sequence"]').click();

    const name = $('input[aria-label="Sequence name"]');
    await expect(name).toHaveValue("sequence-1");
    await name.setValue("acceptance-pipeline");
    await $('input[aria-label="Sequence description"]').setValue("Implement, then review");
    await $('//button[normalize-space(.)="Add step"]').click();
    await setSelectValue('select[aria-label="Sequence step 2"]', "reviewer");
    await $('input[aria-label="Visible steps"]').setValue("2");

    await expect($('select[aria-label="Sequence step 1"]')).toHaveValue("default");
    await expect($('select[aria-label="Sequence step 2"]')).toHaveValue("reviewer");
    await expect($(".sequence-note")).toHaveText(expect.stringContaining("The first 2 step(s)"));
    await expect($(".sequence-note")).toHaveText(expect.stringContaining("0 remaining step(s)"));
    await $('button[aria-label="Remove acceptance-pipeline"]').click();
    await expect($(".sequence-editor .empty-small")).toHaveText("Add a sequence to get started.");
  });

  it("saves the encoded orchestration configuration and reconnects", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({
      ...connectedSessionResponses("orchestration-save"),
      "pi_command:set_model": {}, "pi_command:prompt": {}, save_app_settings: {}, stop_pi: {}, start_pi: {}, list_sessions: [], load_app_settings: settings,
    });
    await emitPiEvent({ type: "session_switched" });
    await enableOrchestration();
    await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/acceptance"));
    await app.openSettings();
    await setSelectValue('select[aria-label="Default model"]', "e2e/acceptance");
    await expect($('select[aria-label="Default model"]')).toHaveValue("e2e/acceptance");
    await app.openSettingsSection("Agents");
    await $('//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="reviewer"]]').click();
    await $('input[aria-label="Agent description"]').setValue("Reviews the packaged acceptance suite");

    await app.saveSettingsButton.click();
    await expect(app.saveSettingsButton).toHaveText("Saved");
    const prompt = (await backendCalls()).find(({ args }) => String((args.command as { message?: string })?.message).startsWith("/pi-orchestration-config "))?.args.command as { message: string };
    const saved = decodeOrchestrationValue<OrchestrationConfig>(prompt.message.slice("/pi-orchestration-config ".length));
    expect(saved.agents.find((agent) => agent.name === "reviewer")?.description).toBe("Reviews the packaged acceptance suite");
    expect((await backendCalls()).filter(({ command }) => command === "save_app_settings")).toHaveLength(1);
    expect((await backendCalls()).some(({ command }) => command === "stop_pi")).toBe(true);
    expect((await backendCalls()).some(({ command }) => command === "start_pi")).toBe(true);
  });

  it("persists a GUI-created agent through a real native save and reconnect", async () => {
    const originalConfig = readFileSync(installedOrchestrationConfigPath);
    const agentName = "e2e-persisted-agent";
    writeFileSync(installedOrchestrationConfigPath, JSON.stringify(acceptanceOrchestration().config, null, 2));
    await resetBackend();
    await browser.refresh();
    await app.waitUntilReady();
    await resetBackend();

    try {
      await app.openSettings();
      await app.settingsSection("Agents").waitForDisplayed(); // [DEBUG-a4f2] Synchronize with the real extension status.
      await app.openSettingsSection("Agents");
      await $('//button[normalize-space(.)="Add agent"]').click();
      await $('input[aria-label="Agent name"]').setValue(agentName);
      await $('input[aria-label="Agent description"]').setValue("Saved by the native acceptance test");
      await $('textarea[aria-label="System prompt"]').setValue("Verify the saved agent configuration.");
      await expect($(`//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="${agentName}"]]`)).toBeExisting(); // [DEBUG-a4f2]
      await expect(app.saveSettingsButton).toBeClickable();
      await app.saveSettingsButton.click();

      await browser.waitUntil(async () => {
        const saved = JSON.parse(readFileSync(installedOrchestrationConfigPath, "utf8")) as OrchestrationConfig;
        return saved.agents.some((agent) => agent.name === agentName) || await app.saveSettingsButton.getText() === "Saved" || await $(".settings-save [role='alert']").isExisting();
      }, { timeout: 30_000, timeoutMsg: "The GUI-created agent was not written to the installed orchestration config" });
      const saved = JSON.parse(readFileSync(installedOrchestrationConfigPath, "utf8")) as OrchestrationConfig;
      if (!saved.agents.some((agent) => agent.name === agentName)) throw new Error(`[DEBUG-a4f2] ${JSON.stringify({ button: await app.saveSettingsButton.getText(), alert: await $(".settings-save [role='alert']").isExisting() ? await $(".settings-save [role='alert']").getText() : undefined, calls: await backendCalls(), agents: saved.agents.map((agent) => agent.name) })}`);
      expect(saved.agents.find((agent) => agent.name === agentName)).toMatchObject({
        description: "Saved by the native acceptance test",
        systemPrompt: "Verify the saved agent configuration.",
      });
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, mocked }) => command === "start_pi" && !mocked), { timeoutMsg: "Saving the agent did not reconnect the native Pi runtime" });

      await app.openConversations();
      await app.agentPicker.click();
      await expect($('[role="listbox"][aria-label="Agent options"]')).toHaveText(expect.stringContaining(agentName));
      await browser.keys("Escape");
      await app.openSettings();
      await app.openSettingsSection("Agents");
      await $(`//div[contains(@class,"agent-list")]//button[.//span[normalize-space(.)="${agentName}"]]`).click();
      await expect($('input[aria-label="Agent description"]')).toHaveValue("Saved by the native acceptance test");
    } finally {
      writeFileSync(installedOrchestrationConfigPath, originalConfig);
      await resetApp();
    }
  });

  it("restores desktop settings when orchestration configuration is rejected", async () => {
    await app.openSettings();
    await mockBackend({ "pi_command:prompt": { error: "Orchestration configuration was rejected" } });
    await app.saveSettingsButton.click();

    await expect($(".settings-save [role='alert']")).toHaveText("Orchestration configuration was rejected");
    const calls = await backendCalls();
    expect(calls.filter(({ command }) => command === "save_app_settings")).toHaveLength(2);
    expect(calls.filter(({ args }) => String((args.command as { message?: string })?.message).startsWith("/pi-orchestration-config "))).toHaveLength(2);
  });
});

describe("Settings acceptance", () => {
  before(async () => {
    await resetApp();
  });

  it("saves the current configuration and confirms success", async () => {
    await app.openSettings();
    await app.saveSettingsButton.click();

    await expect(app.saveSettingsButton).toHaveText("Saved");
    await app.openConversations();
  });

  it("lets the user discover the main configuration areas and return to the conversation", async () => {
    await app.openSettings();
    await expect(app.saveSettingsButton).toHaveText("Save changes");

    for (const section of ["General", "Machines", "Keybinds", "Skills", "Tools", "MCP servers"]) {
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
    await app.openSettingsSection("Tools");
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
    await app.openSettingsSection("MCP servers");
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

    await expect(card.$("select")).toHaveValue("stdio");
    await expect(command).toHaveValue("node");
    await expect(args).toHaveValue("server.js --quiet");
    await $('button[aria-label="Remove Acceptance server"]').click();
    await expect($$("input[aria-label='Server name']")).toBeElementsArrayOfSize(before.length);
    await app.openConversations();
  });

  it("can prepare an HTTP MCP server with headers without saving it", async () => {
    await app.openSettings();
    await app.openSettingsSection("MCP servers");
    const before = await $$('input[aria-label="Server name"]');
    await app.addMcpServerButton.click();
    const names = await $$('input[aria-label="Server name"]');
    const name = names[names.length - 1];
    await name.setValue("Acceptance HTTP");
    const card = await name.$('./ancestor::div[contains(@class, "mcp-card")]');
    await setSelectValue('select[aria-label="Acceptance HTTP transport"]', "http");
    const url = await card.$('input[placeholder="https://example.com/mcp"]');
    const headers = await card.$('input[placeholder*="Authorization"]');
    await url.setValue("https://mcp.example.test/api");
    await headers.setValue('{"Authorization":"Bearer acceptance"}');

    await expect(card.$("select")).toHaveValue("http");
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
      ["Focus composer shortcut", "Ctrl+L"],
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

  it("bulk toggles discoverable skills without changing user-invoked skills", async () => {
    const settings = {
      ...defaultSettings,
      skills: [
        { name: "Explicit only", path: "/skills/explicit", description: "Must be invoked directly", enabled: true, userInvokedOnly: true },
        { name: "Alpha skill", path: "/skills/alpha", description: "Alpha behavior", enabled: false },
        { name: "Beta skill", path: "/skills/beta", description: "Beta behavior", enabled: false },
      ],
    };
    await mockBackend({ ...connectedSessionResponses("skill-settings"), load_app_settings: settings });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openSettings();
      await app.openSettingsSection("Skills");
      await expect($(".skill-invocation")).toHaveText("User invoked only");
      await $('//button[normalize-space(.)="Enable all"]').click();
      await expect($('[role="switch"][aria-label="Enable Alpha skill"]')).toHaveAttribute("aria-checked", "true");
      await expect($('[role="switch"][aria-label="Enable Beta skill"]')).toHaveAttribute("aria-checked", "true");
      await expect($('[role="switch"][aria-label="Enable Explicit only"]')).not.toBeExisting();

      await $('//button[normalize-space(.)="Disable all"]').click();
      await expect($('[role="switch"][aria-label="Enable Alpha skill"]')).toHaveAttribute("aria-checked", "false");
      await expect($('[role="switch"][aria-label="Enable Beta skill"]')).toHaveAttribute("aria-checked", "false");
    } finally {
      await app.openConversations();
      await resetBackend();
    }
  });

  it("filters skills by name without changing configuration", async () => {
    await app.openSettings();
    await app.openSettingsSection("Skills");
    await app.skillFilter.setValue("__webdriver_no_matching_skill__");

    await expect($$(".skill-row")).toBeElementsArrayOfSize(0);
    await app.skillFilter.clearValue();
    await app.openConversations();
  });

  it("can preview a tool toggle and restore it before leaving", async () => {
    await app.openSettings();
    await app.openSettingsSection("Tools");
    const toggles = await $$("[role='switch'][aria-label^='Enable ']");
    expect(toggles.length).toBeGreaterThan(0);
    const toggle = toggles[0];
    const initialValue = await toggle.getAttribute("aria-checked");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", initialValue === "true" ? "false" : "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", initialValue);
    await app.openConversations();
  });
});

describe("Project behavior", () => {
  beforeEach(async () => {
    await resetApp();
  });

  it("browses directories on a configured remote machine", async () => {
    const remote = { id: "acceptance-remote", name: "Acceptance remote", target: "tester@example.com", piPath: "pi" };
    await mockBackend({
      ...connectedSessionResponses("remote-browser"), load_app_settings: { ...defaultSettings, hosts: [remote] },
      home_directory: "/remote/home", list_directories: { path: "/remote/home", parent: "/remote", directories: ["/remote/home/project-a", "/remote/home/project-b"] },
    });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await setSelectValue('select[aria-label="Machine"]', remote.id);
      await expect(app.projectDirectory).toHaveValue("/remote/home");
      await app.chooseDirectoryButton.click();

      const directories = $('[aria-label="Remote directories"]');
      await expect(directories).toBeDisplayed();
      await updateBackendResponse("list_directories", { path: "/remote/home/project-a", parent: "/remote/home", directories: [] });
      await directories.$('button=project-a').click();
      await expect(app.projectDirectory).toHaveValue("/remote/home/project-a");
      await app.cancelProjectButton.click();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectButton.click();
      await resetBackend();
    }
  });

  it("shows an error when a remote machine's home directory cannot be resolved", async () => {
    const remote = { id: "acceptance-home-error", name: "Unreachable remote", target: "tester@unreachable.example", piPath: "pi" };
    await mockBackend({ ...connectedSessionResponses("remote-home-error"), load_app_settings: { ...defaultSettings, hosts: [remote] }, home_directory: "/local/home" });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await updateBackendResponse("home_directory", { error: "Remote home directory is unavailable" });
      await setSelectValue('select[aria-label="Machine"]', remote.id);

      await expect(app.dialogAlert).toHaveText("Remote home directory is unavailable");
      await expect(app.projectDialogHeading).toHaveText("Open project");
      await app.cancelProjectButton.click();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectButton.click();
      await resetBackend();
    }
  });

  it("shows an error when a remote directory cannot be listed", async () => {
    const remote = { id: "acceptance-list-error", name: "Restricted remote", target: "tester@restricted.example", piPath: "pi" };
    await mockBackend({
      ...connectedSessionResponses("remote-list-error"), load_app_settings: { ...defaultSettings, hosts: [remote] },
      home_directory: "/remote/home", list_directories: { error: "Remote directory listing was denied" },
    });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await setSelectValue('select[aria-label="Machine"]', remote.id);
      await expect(app.projectDirectory).toHaveValue("/remote/home");
      await app.chooseDirectoryButton.click();

      await expect(app.dialogAlert).toHaveText("Remote directory listing was denied");
      await expect(app.projectDialogHeading).toHaveText("Open project");
      await app.cancelProjectButton.click();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectButton.click();
      await resetBackend();
    }
  });

  it("switches to a project after the backend connects successfully", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({
      stop_pi: {}, start_pi: {},
      ...connectedSessionResponses("acceptance-project"),
      "pi_command:set_model": {}, load_app_settings: settings, validate_project_directory: "/tmp",
    });
    try {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await app.projectDirectory.setValue("/tmp");
      await app.openProjectButton.click();

      await expect(app.projectDialogHeading).not.toBeExisting();
      await expect($('button[aria-label="Selected project: tmp"]')).toHaveAttribute("title", "/tmp");
      await expect($(".error-toast")).not.toBeExisting();
      expect((await backendCalls()).filter(({ command }) => command === "stop_pi" || command === "start_pi").map(({ command }) => command)).toEqual(["stop_pi", "start_pi"]);
    } finally {
      await resetBackend();
      await browser.refresh();
      await app.waitUntilReady();
    }
  });

  it("changes the model and thinking level for the active project", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({
      ...connectedSessionResponses("acceptance-project"),
      "pi_command:get_state": { model: { provider: "e2e", id: "alternate" }, thinkingLevel: "high", isStreaming: false, sessionId: "acceptance-project", messageCount: 0, pendingMessageCount: 0 },
      "pi_command:set_model": {}, "pi_command:set_thinking_level": {}, validate_project_directory: "/tmp", start_pi: {}, stop_pi: {},
      load_app_settings: settings,
    });
    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await app.projectDirectory.setValue("/tmp");
      await app.openProjectButton.click();
      await expect(app.projectDialogHeading).not.toBeExisting();
      await expect(app.modelPicker).toBeEnabled();
      await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/alternate"));
      await callBridge().setValue("[]");
      await app.chooseComposerOption("Model", "Alternate model");
      await expect(app.modelPicker).toHaveText("Alternate model");
      await app.chooseComposerOption("Thinking level", "off");
      await expect(app.thinkingLevelPicker).toHaveText("off");

      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String((args.command as { type?: string })?.type))).length === 2);
      expect((await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String((args.command as { type?: string })?.type))).map(({ args }) => args.command)).toEqual([
        { type: "set_model", provider: "e2e", modelId: "alternate" }, { type: "set_thinking_level", level: "off" },
      ]);
    } finally {
      await resetBackend();
      await browser.refresh();
      await app.waitUntilReady();
    }
  });

  it("forwards terminal keyboard input to the active project terminal", async () => {
    await startTemporaryConversation({ start_terminal: {}, resize_terminal: {}, write_terminal: {}, close_terminal: {} });
    try {
      await app.openTerminalButton.click();
      const terminalInput = $(".xterm-helper-textarea");
      await terminalInput.waitForExist();
      await terminalInput.click();
      await browser.keys("pwd");
      await browser.keys("Enter");

      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "write_terminal"));
      const input = (await backendCalls()).filter(({ command }) => command === "write_terminal").map(({ args }) => String(args.data)).join("");
      expect(input.length).toBeGreaterThan(1);
      expect(input).toContain("\r");
    } finally {
      if (await app.terminalPanel.isExisting()) await app.deleteTerminalButton.click();
      await resetBackend();
    }
  });

  it("reports a backend connection failure without trapping the user in the chooser", async () => {
    await mockBackend({ stop_pi: {}, start_pi: { error: "Project runtime unavailable" }, validate_project_directory: "/tmp/acceptance-project" });
    try {
      await app.openProjectChooser();
      await app.projectDirectory.setValue("/tmp/acceptance-project");
      await app.openProjectButton.click();

      await expect(app.projectDialogHeading).not.toBeExisting();
      await expect($(".error-toast strong")).toHaveText("Pi could not connect");
      await expect($(".error-toast span")).toHaveText("Project runtime unavailable");
      expect((await backendCalls()).filter(({ command }) => command === "stop_pi" || command === "start_pi").map(({ command }) => command)).toEqual(["stop_pi", "start_pi"]);
    } finally {
      await resetBackend();
    }
  });
});

describe("Conversation lifecycle", () => {
  beforeEach(async () => {
    await resetApp();
  });

  it("keeps a separate composer draft for each conversation", async () => {
    const current = { id: "draft-current", path: "/tmp/draft-current.jsonl", name: "Draft current conversation", project: "Draft project", cwd: "/tmp", preview: "Current draft", messageCount: 1, hostId: "local" };
    const target = { id: "draft-target", path: "/tmp/draft-target.jsonl", name: "Draft target conversation", project: "Draft project", cwd: "/tmp", preview: "Target draft", messageCount: 1, hostId: "local" };
    const state = (sessionId: string) => ({ model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 1, pendingMessageCount: 0 });
    await mockBackend({ list_sessions: [current, target], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance" }, ...connectedSessionResponses(""), "pi_command:set_model": {} });
    try {
      await emitPiEvent({ type: "session_switched" });
      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await expect($(".session-item.active strong")).toHaveText(current.name); // [DEBUG-a4f2] Wait for the selected conversation render.
      await app.composer.waitForEnabled();
      await app.prepareMessage("Draft belonging to the current conversation");

      await updateBackendResponse("pi_command:get_state", state(target.id));
      await app.conversationSearch.setValue(target.name);
      await $(".session-item .session-main").click();
      await expect($(".session-item.active strong")).toHaveText(target.name); // [DEBUG-a4f2] Wait for the selected conversation render.
      await app.composer.waitForEnabled();
      await expect(app.composer).toHaveValue("");
      await app.prepareMessage("Draft belonging to the target conversation");

      await updateBackendResponse("pi_command:get_state", state(current.id));
      await app.conversationSearch.setValue(current.name);
      await $(".session-item .session-main").click();
      await expect($(".session-item.active strong")).toHaveText(current.name); // [DEBUG-a4f2] Wait for the selected conversation render.
      await app.composer.waitForEnabled();
      if (await app.composer.getValue() !== "Draft belonging to the current conversation") throw new Error(`[DEBUG-a4f2] ${JSON.stringify(await browser.execute(() => (window as unknown as { __debugDraftState?: unknown }).__debugDraftState))}`);

      await updateBackendResponse("pi_command:get_state", state(target.id));
      await app.conversationSearch.setValue(target.name);
      await $(".session-item .session-main").click();
      await expect($(".session-item.active strong")).toHaveText(target.name); // [DEBUG-a4f2] Wait for the selected conversation render.
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
    await mockBackend({ list_sessions: [indexed], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance" }, ...connectedSessionResponses(""), "pi_command:set_model": {} });
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
      await split.$('textarea[aria-label="Message Pi"]').setValue("Independent split-pane draft");
      await split.$('button[aria-label="Close split pane"]').click();
      await expect(app.composer).toHaveValue("Main conversation draft");

      split = await openSplit();
      await expect(split.$('textarea[aria-label="Message Pi"]')).toHaveValue("Independent split-pane draft");
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
    const state = (sessionId: string) => ({ model: { provider: "e2e", id: "acceptance" }, thinkingLevel: "high", isStreaming: false, sessionId, messageCount: 0, pendingMessageCount: 0 });
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance" };
    await mockBackend({ list_sessions: [current, target], start_pi: {}, stop_pi: {}, ...connectedSessionResponses("terminal-bootstrap"), "pi_command:set_model": {}, load_app_settings: settings, start_terminal: {}, resize_terminal: {}, close_terminal: {} });
    try {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await emitPiEvent({ type: "session_switched" });
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
    await mockBackend({ list_sessions: [indexed], start_pi: {}, stop_pi: {}, load_app_settings: { ...defaultSettings, defaultModel: "e2e/acceptance" }, ...connectedSessionResponses(""), "pi_command:set_model": {}, "pi_command:new_session": {}, archive_session: {}, start_terminal: {}, resize_terminal: {}, close_terminal: {} });
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
      await session.$('button[aria-label="Archive conversation"]').click();

      await expect(app.terminalPanel).not.toBeExisting();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "archive_session"));
      expect((await backendCalls()).some(({ args }) => (args.command as { type?: string })?.type === "new_session")).toBe(true);
      const terminalState = (await backendCalls()).find(({ command }) => command === "archive_session")?.args.terminalState as { activeId: string; tabs: Array<{ started: boolean }> };
      expect(terminalState.tabs).toHaveLength(1);
      expect(terminalState.tabs[0].started).toBe(true);
    } finally {
      if (await app.terminalPanel.isExisting()) await app.closeTerminalButton.click();
      await app.conversationSearch.clearValue();
      await resetBackend();
    }
  });

  it("starts a fresh conversation in the selected project from the keyboard", async () => {
    await mockBackend({ stop_pi: {}, start_pi: {}, ...connectedSessionResponses("keyboard-session") });
    try {
      await app.openConversations();
      await app.prepareMessage("Discard this old draft");
      await browser.keys(["Control", "n"]);

      await expect(app.composer).toHaveValue("");
      await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "start_pi"));
      expect((await backendCalls()).filter(({ command }) => command === "start_pi")).toHaveLength(1);
    } finally {
      await resetBackend();
    }
  });
});
