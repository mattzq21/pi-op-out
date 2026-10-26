import { $, browser, expect } from "@wdio/globals";

import { mockBackend, backendCalls, resetBackend, resetApp, emitPiEvent, connectedSessionResponses, startTemporaryConversation } from './acceptance-fixture.js';

interface SideChatRequest { kind?: string; name?: string; task?: string; cwd?: string; hostId?: string; parentSessionId?: string; sessionId?: string; sessionPath?: string }

describe("side pane acceptance", () => {
  let mainSessionId = "";
  const request = (id: string, payload: SideChatRequest) => emitPiEvent({
    type: "extension_ui_request",
    id,
    method: "input",
    title: "__pi_desktop_auxiliary__",
    placeholder: JSON.stringify(payload),
  });
  const review = (task: string): SideChatRequest => ({ kind: "review", name: "Code review", task, parentSessionId: mainSessionId, sessionId: "review-runtime", sessionPath: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-sidepane", hostId: "local" });

  const runtimeResponses = () => ({
    ...connectedSessionResponses("review-runtime"),
    list_sessions: [{ id: "review-runtime", path: "/tmp/review-session.jsonl", cwd: "/tmp/acceptance-sidepane", name: "Code review", project: "Review project", preview: "", hostId: "local", messageCount: 0, auxiliaryParentId: mainSessionId, auxiliaryKind: "review" }],
    "pi_command:get_state": { ...connectedSessionResponses("review-runtime")["pi_command:get_state"] },
    "pi_command:prompt": {}, "pi_command:extension_ui_response": {},
  });
  const sideChat = () => $('section[aria-label="Side chat: Code review"]');
  const toggle = () => $('button.open-plugins-button');

  beforeEach(async () => {
    await resetApp();
    mainSessionId = (await startTemporaryConversation({})).sessionId;
  });
  afterEach(async () => {
    if (await sideChat().isExisting()) await toggle().click();

    if (await $(".error-toast").isExisting()) await $(".error-toast button").click();
    await resetBackend();
  });

  it("opens a review as a side pane tab and sends its first prompt", async () => {
    await mockBackend(runtimeResponses());
    await request("side-success", review("Review the changed API"));

    await expect(sideChat()).toBeDisplayed();
    await expect($('[role="tab"][aria-selected="true"]')).toHaveText("Code review");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.message === "Review the changed API"));
    expect((await backendCalls()).find(({ command }) => command === "start_pi")?.args).toEqual(expect.objectContaining({ cwd: "/tmp/acceptance-sidepane", sessionId: "review-runtime", hostId: "local" }));

    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "side-success"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "side-success")?.args.command).toMatchObject({ type: "extension_ui_response", id: "side-success", value: "opened" });
  });

  it("hides the side pane without cancelling its acknowledged request, and shows the tab again", async () => {
    await mockBackend(runtimeResponses());
    await request("side-hide", review("Investigate separately"));

    await expect(sideChat()).toBeDisplayed();
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "side-hide"));
    await toggle().click();
    await expect(sideChat()).not.toBeExisting();
    const responses = (await backendCalls()).filter(({ args }) => args.command?.id === "side-hide");
    expect(responses).toHaveLength(1);
    expect(responses[0].args.command).toMatchObject({ type: "extension_ui_response", id: "side-hide", value: "opened" });
    await toggle().click();
    await expect(sideChat()).toBeDisplayed();
  });

  it("rejects a malformed side chat request", async () => {
    await mockBackend({ "pi_command:extension_ui_response": {} });
    await request("side-invalid", { task: "", cwd: "/tmp/acceptance-sidepane" });

    await expect(sideChat()).not.toBeExisting();
    await expect($(".error-toast strong")).toHaveText("Could not open the side chat");
    await expect($(".error-toast span")).toHaveText("Invalid side chat request");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "side-invalid"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "side-invalid")?.args.command).toMatchObject({ type: "extension_ui_response", id: "side-invalid", cancelled: true });
  });

  it("reports when the side chat runtime cannot start", async () => {
    await mockBackend({ ...runtimeResponses(), start_pi: { error: "Fork runtime unavailable" } });
    await request("side-start-failure", review("Review separately"));

    await expect(sideChat()).toBeDisplayed();
    await expect(sideChat().$(".split-pane-status.error")).toHaveText("Fork runtime unavailable");
    await browser.waitUntil(async () => (await backendCalls()).some(({ args }) => args.command?.id === "side-start-failure"));
    expect((await backendCalls()).find(({ args }) => args.command?.id === "side-start-failure")?.args.command).toMatchObject({ type: "extension_ui_response", id: "side-start-failure", cancelled: true });
  });
});
