import { $, browser } from "@wdio/globals";

declare global {
  interface Window { __e2eConfirmation?: { original: typeof window.confirm; messages: string[] } }
}

class AppPage {
  get root() { return $(".app:not(.app-loading)"); }
  get composer() { return $('textarea[aria-label="Message piop"]'); }
  get sendMessageButton() { return $('button[aria-label="Send message"]'); }
  get agentPicker() { return $('button[aria-label="Agent"]'); }
  get modelPicker() { return $('button[aria-label="Model"]'); }
  get thinkingLevelPicker() { return $('button[aria-label="Thinking level"]'); }
  get openTerminalButton() { return $('button[aria-label="Open terminal"]'); }
  get terminalPanel() { return $('section[aria-label="Session terminal"]'); }
  get addTerminalButton() { return $('button[aria-label="Add terminal"]'); }
  get deleteTerminalButton() { return $('button[aria-label="Delete terminal"]'); }
  get closeTerminalButton() { return $('button[aria-label="Close terminal panel"]'); }
  get newProjectButton() { return $('button[aria-label="Choose project"], button[aria-label^="Selected project:"]'); }
  get conversationsButton() { return $('button[aria-label="Go back"]'); }
  get conversationSearch() { return $('input[aria-label="Search conversations"]'); }
  get emptyConversationSearch() { return $(".session-panel .empty-small"); }
  get settingsButton() { return $('button[aria-label="Settings"]'); }
  get settingsHeading() { return $("h1"); }
  get settingsSectionHeading() { return $(".settings-content h2"); }
  get saveSettingsButton() { return $(".settings-save > button.primary-button"); }
  get projectDialogHeading() { return $("#project-dialog-title"); }
  get extensionDialogHeading() { return $('dialog.extension-dialog:not([aria-labelledby="project-dialog-title"]) h2'); }
  get projectDirectory() { return $('.directory-palette input[role="combobox"]'); }
  get cancelProjectButton() { return $(".directory-palette-escape"); }
  get openProjectButton() { return $(".directory-palette-open"); }
  get dialogAlert() { return $('.directory-palette [role="alert"]'); }
  get automaticRetryToggle() { return $('[role="switch"][aria-label="Automatic retry"]'); }
  get addHostButton() { return $('//button[normalize-space(.)="Add host"]'); }
  get addMcpServerButton() { return $('//button[normalize-space(.)="Add MCP server"]'); }
  get restoreKeybindsButton() { return $('//button[normalize-space(.)="Restore defaults"]'); }
  get contextWindowCap() { return $('input[aria-label="Context window cap"]'); }

  settingsSection(label: string) {
    return $(`//nav[contains(@class, "settings-nav")]//button[normalize-space(.)="${label}"]`);
  }

  async waitUntilReady() {
    await this.root.waitForDisplayed();
    await this.composer.waitForDisplayed();
  }

  async openSettings() {
    await this.settingsButton.click();
    await this.settingsHeading.waitForDisplayed();
    await $('//nav[contains(@class, "settings-nav")]//button[normalize-space(.)="Local"]').click();
    await this.settingsSection("General").waitForDisplayed();
  }

  async openConversations() {
    if (await this.conversationsButton.isExisting()) {
      await this.confirmAction("Discard unsaved settings changes?", () => this.conversationsButton.click(), true);
    }

    await this.composer.waitForDisplayed();
  }

  async confirmAction<T>(message: string, action: () => Promise<T>, optional = false) {
    await browser.execute((expected) => {
      const messages: string[] = [];
      window.__e2eConfirmation = { original: window.confirm, messages };
      window.confirm = (value) => {
        const text = String(value);
        messages.push(text);

        return text === expected;
      };
    }, message);
    let messages: string[] = [];

    try {
      await action();
    } finally {
      messages = await browser.execute(() => {
        const confirmation = window.__e2eConfirmation;

        if (!confirmation) throw new Error("Confirmation capture was not installed");
        window.confirm = confirmation.original;
        delete window.__e2eConfirmation;

        return confirmation.messages;
      });
    }

    if ((!optional && messages.length !== 1) || messages.some((value) => value !== message)) {
      throw new Error(`Expected confirmation ${JSON.stringify(message)}, received ${JSON.stringify(messages)}`);
    }
  }

  async refreshForReset() {
    await browser.refresh();
  }

  async prepareMessage(message: string) {
    await this.composer.setValue(message);
  }

  async clearMessage() {
    if (await this.composer.getValue()) await this.composer.clearValue();
  }

  async openSettingsSection(label: string) {
    if (!["Keybinds", "Models", "Hosts"].includes(label) && !(await this.settingsSection(label).isExisting())) {
      await $('//nav[contains(@class, "settings-nav")]//button[normalize-space(.)="This computer"]').click();
    }

    await this.settingsSection(label).click();
    await this.settingsSectionHeading.waitForDisplayed();

    if (label === "Agents") {
      try { await $('//button[normalize-space(.)="Add agent"]').waitForEnabled(); }
      catch (cause) { throw new Error(`Agent settings unavailable: ${await $("body").getText()}`, { cause }); }
    }
  }

  async openProjectChooser() {
    await this.newProjectButton.click();
    await this.projectDialogHeading.waitForDisplayed();
  }

  async cancelProjectChooser() {
    await this.cancelProjectButton.waitForEnabled();
    await this.cancelProjectButton.click();
    await this.projectDialogHeading.waitForExist({ reverse: true });
  }

  async setProjectPath(path: string) {
    await this.openProjectButton.waitForEnabled();

    if (await this.projectDirectory.getAttribute("aria-label") === "Folder path relative to home") {
      await browser.execute(() => {
        const input = document.querySelector('.directory-palette input');

        if (!input) throw new Error("Directory input was not found");

        return input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", altKey: true, bubbles: true, cancelable: true }));
      });
      await browser.waitUntil(async () => await this.projectDirectory.getAttribute("aria-label") === "Search or type a folder path");
    }

    await this.projectDirectory.setValue(`${path.replace(/\/$/, "")}/`);
    await this.openProjectButton.waitForEnabled();
  }

  async chooseComposerOption(label: "Agent" | "Model" | "Thinking level" | "Streaming message behavior", option: string) {
    await $(`button[aria-label="${label}"]`).click();
    const choice = $(`//div[@role="listbox" and @aria-label="${label} options"]//button[.//span[normalize-space(.)="${option}"]]`);
    await choice.waitForClickable();
    await choice.click();
  }
}

export const app = new AppPage();
