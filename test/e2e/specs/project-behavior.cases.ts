import { $, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { callBridge, mockBackend, backendCalls, updateBackendResponse, resetBackend, resetApp, emitPiEvent, defaultSettings, setSelectValue, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

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
      await app.openProjectChooser();
      await updateBackendResponse("home_directory", { error: "Remote home directory is unavailable" });
      await setSelectValue('select[aria-label="Machine"]', remote.id);

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
      await app.openProjectChooser();
      await setSelectValue('select[aria-label="Machine"]', remote.id);
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
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" };
    await mockBackend({
      stop_pi: {}, start_pi: {},
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
      await expect($('button[aria-label="Selected project: tmp"]')).toHaveAttribute("title", "/tmp");
      await expect($(".error-toast")).not.toBeExisting();
      expect((await backendCalls()).filter(({ command }) => command === "stop_pi" || command === "start_pi").map(({ command }) => command)).toEqual(["stop_pi", "start_pi"]);
    } finally {
      await resetBackend();
      await app.refreshForReset();
      await app.waitUntilReady();
    }
  });

  it("changes the model and thinking level for the active project", async () => {
    const settings = { ...defaultSettings, defaultModel: "e2e/acceptance", defaultThinking: "high" };
    await mockBackend({
      ...connectedSessionResponses("acceptance-project"),
      "pi_command:get_state": { model: { provider: "e2e", id: "alternate", name: "Alternate model" }, thinkingLevel: "high", isStreaming: false, sessionId: "acceptance-project", messageCount: 0, pendingMessageCount: 0 },
      "pi_command:set_model": {}, "pi_command:set_thinking_level": {}, validate_project_directory: "/tmp", start_pi: {}, stop_pi: {},
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
      await callBridge().setValue("[]");
      await app.chooseComposerOption("Model", "Alternate model");
      await expect(app.modelPicker).toHaveText("Alternate model");
      await app.chooseComposerOption("Thinking level", "Off");
      await expect(app.thinkingLevelPicker).toHaveText("Off");

      expect((await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String((args.command as { type?: string })?.type)))).toHaveLength(0);
      await app.prepareMessage("Use the selected model and effort");
      await app.sendMessageButton.click();
      await browser.waitUntil(async () => (await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String((args.command as { type?: string })?.type))).length === 2);
      expect((await backendCalls()).filter(({ args }) => ["set_model", "set_thinking_level"].includes(String((args.command as { type?: string })?.type))).map(({ args }) => args.command)).toEqual([
        { type: "set_model", provider: "e2e", modelId: "alternate" }, { type: "set_thinking_level", level: "off" },
      ]);
    } finally {
      await resetBackend();
      await app.refreshForReset();
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
    await mockBackend({ stop_pi: {}, start_pi: { error: "Project runtime unavailable" }, validate_project_directory: "/tmp/acceptance-project", list_directories: { path: "/tmp/acceptance-project", parent: "/tmp", directories: [] } });
    try {
      await app.openProjectChooser();
      await app.setProjectPath("/tmp/acceptance-project");
      await app.openProjectButton.click();

      await expect(app.projectDialogHeading).not.toBeExisting();
      await expect($(".error-toast strong")).toHaveText("piop could not connect");
      await expect($(".error-toast span")).toHaveText("Project runtime unavailable");
      expect((await backendCalls()).filter(({ command }) => command === "stop_pi" || command === "start_pi").map(({ command }) => command)).toEqual(["stop_pi", "start_pi"]);
    } finally {
      await resetBackend();
    }
  });
});
