import { $ } from "@wdio/globals";

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
  get newProjectButton() { return $('button[aria-label="New project"]'); }
  get conversationsButton() { return $('button[aria-label="Conversations"]'); }
  get conversationSearch() { return $('input[aria-label="Search conversations"]'); }
  get emptyConversationSearch() { return $(".session-panel .empty-small"); }
  get settingsButton() { return $('button[aria-label="Settings"]'); }
  get settingsHeading() { return $("h1"); }
  get settingsSectionHeading() { return $(".settings-content h2"); }
  get saveSettingsButton() { return $(".settings-save button"); }
  get projectDialogHeading() { return $("#project-dialog-title"); }
  get projectDirectory() { return $('input[aria-label="Project directory"]'); }
  get cancelProjectButton() { return $('//section[@role="dialog"]//button[normalize-space(.)="Cancel"]'); }
  get openProjectButton() { return $('//section[@role="dialog"]//button[normalize-space(.)="Open project"]'); }
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
    await this.conversationsButton.click();
    await this.composer.waitForDisplayed();
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

  async chooseComposerOption(label: "Agent" | "Model" | "Thinking level", option: string) {
    await $(`button[aria-label="${label}"]`).click();
    const choice = $(`//div[@role="listbox" and @aria-label="${label} options"]//button[.//span[normalize-space(.)="${option}"]]`);
    await choice.waitForClickable();
    await choice.click();
  }
}

export const app = new AppPage();
