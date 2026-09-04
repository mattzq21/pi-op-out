import { $, browser } from "@wdio/globals";

type ConfirmationWindow = Window & { __e2eConfirmation?: { original: typeof window.confirm; messages: string[] } };

class AppPage {
  get root() { return $(".app"); }
  get composer() { return $('textarea[aria-label="Message Pi"]'); }
  get sendMessageButton() { return $('button[aria-label="Send message"]'); }
  get agentPicker() { return $('button[aria-label="Agent"]'); }
  get modelPicker() { return $('button[aria-label="Model"]'); }
  get thinkingLevelPicker() { return $('button[aria-label="Thinking level"]'); }
  get attachFilesButton() { return $('button[aria-label="Attach files"]'); }
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
  get saveSettingsButton() { return $(".settings-save button"); }
  get projectDialogHeading() { return $("#project-dialog-title"); }
  get extensionDialogHeading() { return $('dialog.extension-dialog:not([aria-labelledby="project-dialog-title"]) h2'); }
  get projectDirectory() { return $('input[aria-label="Project directory"]'); }
  get cancelProjectButton() { return $('//dialog//button[normalize-space(.)="Cancel"]'); }
  get openProjectButton() { return $('//dialog//button[normalize-space(.)="Open project"]'); }
  get chooseDirectoryButton() { return $(".browse-directory"); }
  get dialogAlert() { return $('[role="alert"]'); }
  get automaticRetryToggle() { return $('[role="switch"][aria-label="Automatic retry"]'); }
  get addMachineButton() { return $('//button[normalize-space(.)="Add machine"]'); }
  get addMcpServerButton() { return $('//button[normalize-space(.)="Add MCP server"]'); }
  get restoreKeybindsButton() { return $('//button[normalize-space(.)="Restore defaults"]'); }
  get skillFilter() { return $('input[aria-label="Filter skills by name"]'); }
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
  }

  async openConversations() {
    if (await this.conversationsButton.isExisting()) {
      await this.confirmAction("Discard unsaved settings changes?", () => this.conversationsButton.click(), true);
    }
    await this.composer.waitForDisplayed();
  }

  async confirmAction(message: string, action: () => Promise<unknown>, optional = false) {
    await browser.execute((expected) => {
      const target = window as ConfirmationWindow;
      target.__e2eConfirmation = { original: window.confirm, messages: [] };
      window.confirm = (value) => {
        const text = String(value);
        target.__e2eConfirmation!.messages.push(text);
        return text === expected;
      };
    }, message);
    let messages: string[] = [];
    try {
      await action();
    } finally {
      messages = await browser.execute(() => {
        const target = window as ConfirmationWindow;
        const confirmation = target.__e2eConfirmation!;
        window.confirm = confirmation.original;
        delete target.__e2eConfirmation;
        return confirmation.messages;
      });
    }
    if ((!optional && messages.length !== 1) || messages.some((value) => value !== message)) {
      throw new Error(`Expected confirmation ${JSON.stringify(message)}, received ${JSON.stringify(messages)}`);
    }
  }

  async refreshForReset() {
    // Intentional test resets discard drafts; normal navigation keeps its unload protection.
    await browser.execute(() => {
      window.addEventListener("beforeunload", (event) => event.stopImmediatePropagation(), { capture: true, once: true });
    });
    await browser.refresh();
  }

  async prepareMessage(message: string) {
    await this.composer.setValue(message);
  }

  async clearMessage() {
    if (await this.composer.getValue()) await this.composer.clearValue();
  }

  async openSettingsSection(label: string) {
    await this.settingsSection(label).click();
    await this.settingsSectionHeading.waitForDisplayed();
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

  async chooseComposerOption(label: "Agent" | "Model" | "Thinking level", option: string) {
    await $(`button[aria-label="${label}"]`).click();
    const choice = $(`//div[@role="listbox" and @aria-label="${label} options"]//button[.//span[normalize-space(.)="${option}"]]`);
    await choice.waitForClickable();
    await choice.click();
  }
}

export const app = new AppPage();
