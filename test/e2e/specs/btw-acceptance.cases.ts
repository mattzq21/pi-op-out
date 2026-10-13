import { $, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { isUserPrompt, mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

interface ReviewRequest { task: string; cwd: string; parentSessionId?: string; sessionId?: string; sessionPath?: string }

describe("/review acceptance", () => {
  const request = (id: string, payload: ReviewRequest) => emitPiEvent({
    type: "extension_ui_request",
    id,
    method: "input",
    title: "__pi_desktop_review__",
    placeholder: JSON.stringify(payload),
  });

  const runtimeResponses = () => ({
    ...connectedSessionResponses("review-runtime"),
    list_sessions: [{ id: "review-runtime", path: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-btw", name: "Code review", project: "Review project", preview: "", hostId: "local", messageCount: 0 }],
    "pi_command:prompt": {}, "pi_command:extension_ui_response": {},
  });

  beforeEach(async () => {
    await resetApp();
    await app.openConversations();
    await startTemporaryConversation({});
  });
  afterEach(async () => {
    const split = $('section[aria-label="Split conversation: Code review"]');

    if (await split.isExisting()) await split.$('button[aria-label="Close split pane"]').click();

    if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
    await resetBackend();
  });

  it("opens a persistent review side conversation", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-success", { task: "Review the changed API", parentSessionId: "parent", sessionId: "review-runtime", sessionPath: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: Code review"]');
    await expect(split).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.message === "Review the changed API"));
    expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/acceptance-btw", sessionId: "review-runtime", hostId: "local" }));
    expect((await backendCalls()).find(({ args }) => args.command?.message === "Review the changed API")?.args.command).toMatchObject({ type: "prompt", message: "Review the changed API" });

    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "btw-success"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "btw-success")?.args.command).toMatchObject({ type: "extension_ui_response", id: "btw-success", value: "opened" });

    await emitPiEvent({ type: "agent_settled" });
    await expect(split).toBeDisplayed();
  });

  it("closes an opened side conversation without cancelling its acknowledged request", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-cancel", { task: "Investigate separately", parentSessionId: "parent", sessionId: "review-runtime", sessionPath: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: Code review"]');
    await expect(split).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "btw-cancel"));
    await split.$('button[aria-label="Close split pane"]').click();
    await expect(split).not.toBeExisting();
    const responses = (await backendCalls()).filter(({ args }) => args.command?.id === "btw-cancel");
    expect(responses).toHaveLength(1);
    expect(responses[0].args.command).toMatchObject({ type: "extension_ui_response", id: "btw-cancel", value: "opened" });
    await browser.waitUntil(async () => (await backendCalls()).some(({ command }) => command === "stop_pi"));
  });

  it("rejects a malformed side-conversation request", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    await request("btw-invalid", { task: "", cwd: "/tmp/acceptance-btw" });

    await expect($('section[aria-label="Split conversation: Code review"]')).not.toBeExisting();
    await expect($(".error-toast strong")).toHaveText("Could not start /review");
    await expect($(".error-toast span")).toHaveText("Invalid /review request");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "btw-invalid"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "btw-invalid")?.args.command).toMatchObject({ type: "extension_ui_response", id: "btw-invalid", cancelled: true });
  });

  it("reports when the review runtime cannot start", async () => {
    await mockBackend({ ...runtimeResponses(), start_pi: { error: "Fork runtime unavailable" } });
    await request("btw-start-failure", { task: "Review separately", parentSessionId: "parent", sessionId: "review-runtime", sessionPath: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-btw" });

    const split = $('section[aria-label="Split conversation: Code review"]');
    await expect(split).toBeDisplayed();
    await expect(split.$(".split-pane-status.error")).toHaveText("Fork runtime unavailable");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "btw-start-failure"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "btw-start-failure")?.args.command).toMatchObject({ type: "extension_ui_response", id: "btw-start-failure", cancelled: true });
  });

  it("keeps a settled side conversation open when it has no answer", async () => {
    await mockBackend(runtimeResponses());
    await request("btw-no-answer", { task: "Find an answer", parentSessionId: "parent", sessionId: "review-runtime", sessionPath: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-btw" });
    await expect($('section[aria-label="Split conversation: Code review"]')).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => isUserPrompt(args.command)));

    await emitPiEvent({ type: "agent_settled" });
    await expect($('section[aria-label="Split conversation: Code review"]')).toBeDisplayed();
    await expect($(".error-toast")).not.toBeExisting();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "btw-no-answer"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "btw-no-answer")?.args.command).toMatchObject({ type: "extension_ui_response", id: "btw-no-answer", value: "opened" });
  });
});
