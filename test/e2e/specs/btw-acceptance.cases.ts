import { $, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { isUserPrompt, mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, connectedSessionResponses } from './acceptance-fixture.js';

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
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { message?: string })?.message === "Review the changed API"));
    expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/acceptance-btw", forkPath: "/tmp/source-session.jsonl", hostId: "local" }));
    expect((await backendCalls()).find(({ args }) => (args.command as { message?: string })?.message === "Review the changed API")?.args.command).toEqual({ type: "prompt", message: "Review the changed API" });

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
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));

    await emitPiEvent({ type: "agent_settled" });
    await expect($('section[aria-label="Split conversation: BTW"]')).toBeDisplayed();
    await expect($(".error-toast")).not.toBeExisting();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => (args.command as { id?: string })?.id === "btw-no-answer"));
    expect((await backendCalls()).find(({ args }) => (args.command as { id?: string })?.id === "btw-no-answer")?.args.command).toEqual({ type: "extension_ui_response", id: "btw-no-answer", value: "opened" });
  });
});
