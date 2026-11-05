import { $, browser, expect } from "@wdio/globals";

import { draftCatalog } from "../bridge/draft-catalog.js";
import { app } from "../pageobjects/app.page.js";
import { mockBackend, backendCalls, resetBackend, resetApp, acceptanceAgents } from './acceptance-fixture.js';

describe("Settings behavior", () => {
  before(async () => {
    await resetApp();
  });

  it("keeps edited settings and explains when the backend rejects saving", async () => {
    await mockBackend({ save_app_settings: { error: "Settings disk is read-only" }, "provider_auth:draft_catalog": { ...draftCatalog, config: acceptanceAgents().config } });
    await browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "pi://agent-definitions-changed", payload: { hostId: "local" } }));

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
