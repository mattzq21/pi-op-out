import { $, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, resetBackend, resetApp } from './acceptance-fixture.js';

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
