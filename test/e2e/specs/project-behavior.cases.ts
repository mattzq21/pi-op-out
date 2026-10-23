import { $, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { setBridgeValue, mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, connectedSessionResponses, startTemporaryConversation, failureState } from './acceptance-fixture.js';

async function chooseRemote(host: { id: string; name: string; target: string; piPath: string }) {
  const settings = { ...defaultSettings, hosts: [host] };
  await updateBackendResponse("load_host_settings", settings);
  await updateBackendResponse("load_host_settings_change", { settings });
  await browser.execute(async settings => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://settings-changed", payload: { settings } });
  }, settings);
  const picker = $('button[aria-label^="Host:"]');
  await picker.waitForEnabled();
  await expect(picker).toHaveAttribute("data-options", expect.stringContaining(host.id));
  await picker.click();
  await $(`[role="listbox"][aria-label="Host options"] [data-value="${host.id}"]`).click();
  await expect(picker).toHaveAttribute("data-value", host.id);
}

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
      await chooseRemote(remote);
      await app.openProjectChooser();
      await expect(app.projectDirectory).toHaveValue("");
      const directories = $('[aria-label="Matching folders"]');
      await expect(directories).toBeDisplayed();
      const folder = directories.$('.//div[@role="option"][.//span[normalize-space(.)="project-a"]]');
      await folder.waitForDisplayed();
      await updateBackendResponse("list_directories", { path: "/remote/home/project-a", parent: "/remote/home", directories: [] });
      await folder.click();
      await expect(app.projectDirectory).toHaveValue("project-a/");
      await app.cancelProjectChooser();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectChooser();
      await resetBackend();
    }
  });

  it("shows an error when a remote machine's home directory cannot be resolved", async () => {
    const remote = { id: "acceptance-home-error", name: "Unreachable remote", target: "tester@unreachable.example", piPath: "pi" };
    await mockBackend({ ...connectedSessionResponses("remote-home-error"), load_app_settings: { ...defaultSettings, hosts: [remote] }, home_directory: "/local/home" });

    try {
      await emitPiEvent({ type: "session_switched" });
      await chooseRemote(remote);
      await updateBackendResponse("home_directory", { error: "Remote home directory is unavailable" });
      await app.openProjectChooser();

      await expect(app.dialogAlert).toHaveText("Remote home directory is unavailable");
      await expect(app.projectDialogHeading).toHaveText("Jump to a folder");
      await app.cancelProjectChooser();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectChooser();
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
      await chooseRemote(remote);
      await app.openProjectChooser();
      await expect(app.projectDirectory).toHaveValue("");

      await expect(app.dialogAlert).toHaveText("Remote directory listing was denied");
      await expect(app.projectDialogHeading).toHaveText("Jump to a folder");
      await app.cancelProjectChooser();
    } finally {
      if (await app.projectDialogHeading.isExisting()) await app.cancelProjectChooser();
      await resetBackend();
    }
  });

  it("switches to a project after the backend connects successfully", async () => {
    const settings = { ...defaultSettings, defaultThinking: "high" };
    await mockBackend({
      ...connectedSessionResponses("acceptance-project"),
      "pi_command:set_model": {}, load_app_settings: settings, validate_project_directory: "/tmp",
    });

    try {
      while (await $(".error-toast button").isExisting()) await $(".error-toast button").click();
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await app.setProjectPath("/tmp");
      await app.openProjectButton.click();

      await expect(app.projectDialogHeading).not.toBeExisting();
      await expect($('button[aria-label="Selected project: tmp"]')).toHaveAttribute("data-tooltip", "/tmp");
      await expect($(".error-toast")).not.toBeExisting();
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp")).toHaveLength(0);
      await app.chooseComposerOption("Model", "Acceptance model");
      await app.prepareMessage("Activate the selected project");
      await app.sendMessageButton.click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args }) => command === "pi_command" && args.command?.type === "prompt" && args.command.message === "Activate the selected project"));
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp")).toHaveLength(1);
      expect((await backendCalls()).find(({ command, args }) => command === "start_pi" && args.cwd === "/tmp")?.args.cwd).toBe("/tmp");
    } finally {
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("changes the model and thinking level for the active project", async () => {
    const models = [
      { provider: "e2e", id: "acceptance", name: "Acceptance model", reasoning: true },
      { provider: "e2e", id: "alternate", name: "Alternate model", reasoning: true },
    ];
    const settings = { ...defaultSettings, defaultThinking: "high", knownModels: ["e2e/acceptance", "e2e/alternate"], hiddenModels: [] };
    await mockBackend({
      ...connectedSessionResponses("acceptance-project"),
      "pi_command:get_available_models": { models },
      "pi_command:get_state": { ...connectedSessionResponses("acceptance-project")["pi_command:get_state"], model: models[0], sessionFile: "/tmp/acceptance-project.jsonl" },
      "pi_command:set_model": {}, "pi_command:set_thinking_level": {}, validate_project_directory: "/tmp", start_pi: {}, stop_pi: false,
      load_app_settings: settings,
    });

    try {
      await emitPiEvent({ type: "session_switched" });
      await app.openProjectChooser();
      await app.setProjectPath("/tmp");
      await app.openProjectButton.click();
      await expect(app.projectDialogHeading).not.toBeExisting();
      await emitPiEvent({ type: "session_switched" });
      await expect(app.modelPicker).toBeEnabled();
      await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/alternate"));
      await app.chooseComposerOption("Model", "Acceptance model");
      await app.prepareMessage("Activate the project before changing controls");
      await app.sendMessageButton.click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args }) => command === "pi_command" && args.command?.type === "prompt" && args.command.message === "Activate the project before changing controls"));
      await emitPiEvent({ type: "settings_applied" });
      await emitPiEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Activate the project before changing controls" }], timestamp: Date.now() } });
      await emitPiEvent({ type: "agent_end", messages: [] });
      await expect(app.composer).toHaveValue("");
      await expect(app.composer).toBeEnabled();
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp")).toHaveLength(1);
      await expect(app.modelPicker).toHaveAttribute("data-options", expect.stringContaining("e2e/alternate"));
      await expect(app.modelPicker).toBeEnabled();
      await setBridgeValue("E2E calls", "[]");
      await app.chooseComposerOption("Model", "Alternate model");
      await expect(app.modelPicker).toHaveAttribute("data-value", "e2e/alternate");
      await app.chooseComposerOption("Thinking level", "Off");
      await expect(app.thinkingLevelPicker).toHaveAttribute("data-value", "off");

      expect((await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String(args.command?.type)))).toHaveLength(0);
      await updateBackendResponse("pi_command:get_state", { ...connectedSessionResponses("acceptance-project")["pi_command:get_state"], model: models[1], thinkingLevel: "off", sessionFile: "/tmp/acceptance-project.jsonl", messageCount: 1 });
      await app.prepareMessage("Use the selected model and effort");
      await app.sendMessageButton.click();
      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args }) => command === "pi_command" && args.command?.type === "prompt" && args.command.message === "Use the selected model and effort"));
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp")).toHaveLength(0);
      expect((await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String(args.command?.type))).map(({ args }) => args.command)).toMatchObject([
        { type: "set_model", provider: "e2e", modelId: "alternate" }, { type: "set_thinking_level", level: "off" },
      ]);
    } catch (cause) {
      throw new Error(`${String(cause)} ${await failureState()} picker=${await app.modelPicker.getAttribute("data-options")} page=${await $("body").getText()}`, { cause });
    } finally {
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("forwards terminal keyboard input to the active project terminal", async () => {
    await startTemporaryConversation({ "shared_terminal:start": {}, "shared_terminal:resize": {}, "shared_terminal:write_with_draft": {}, "shared_terminal:close": {} });

    try {
      await app.openTerminalButton.click();
      const terminalInput = $(".xterm-helper-textarea");
      await terminalInput.waitForExist();
      await $(".xterm-screen").click();
      await expect(terminalInput).toBeFocused();
      await browser.keys("pwd");
      await browser.keys("Enter");

      await browser.waitUntil(async () => (await backendCalls()).some(({ command, args }) => command === "shared_terminal" && args.action === "write_with_draft"));
      const input = (await backendCalls()).filter(({ command, args }) => command === "shared_terminal" && args.action === "write_with_draft").map(({ args }) => String(args.data)).join("");
      expect(input.length).toBeGreaterThan(1);
      expect(input).toContain("\r");
    } finally {
      if (await app.terminalPanel.isDisplayed()) await app.deleteTerminalButton.click();
      await resetBackend();
    }
  });

  it("reports a backend connection failure without trapping the user in the chooser", async () => {
    await mockBackend({ ...connectedSessionResponses("project-failure"), load_app_settings: defaultSettings, stop_pi: false, start_pi: { error: "Project runtime unavailable" }, validate_project_directory: "/tmp/acceptance-project", new_chat_branches: null, list_directories: { path: "/tmp/acceptance-project", parent: "/tmp", directories: [] } });

    try {
      await app.openProjectChooser();
      await app.setProjectPath("/tmp/acceptance-project");
      await app.openProjectButton.click();

      await expect(app.projectDialogHeading).not.toBeExisting();
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp/acceptance-project")).toHaveLength(0);
      await app.chooseComposerOption("Model", "Acceptance model");
      await app.prepareMessage("Try the selected project");
      await app.sendMessageButton.click();
      await expect($(".upload-error")).toHaveText(expect.stringContaining("Project runtime unavailable"));
      await expect(app.composer).toBeDisplayed();
      expect((await backendCalls()).filter(({ command, args }) => command === "start_pi" && args.cwd === "/tmp/acceptance-project")).toHaveLength(1);
      expect((await backendCalls()).find(({ command, args }) => command === "start_pi" && args.cwd === "/tmp/acceptance-project")?.args.cwd).toBe("/tmp/acceptance-project");
    } finally {
      await resetBackend();
    }
  });
});
