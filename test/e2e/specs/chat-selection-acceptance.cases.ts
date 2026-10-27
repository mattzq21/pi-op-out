import { $, $$, browser, expect } from "@wdio/globals";

import { app } from "../pageobjects/app.page.js";
import { resetBackend, resetApp, emitPiEvent, startTemporaryConversation } from "./acceptance-fixture.js";

/** A conversation of 20 questions with long answers, so most turns are off screen. */
const longHistory = () => {
  const entries = Array.from({ length: 20 }, (_, index) => [
    { type: "message", id: `selection-user-${index}`, parentId: index ? `selection-assistant-${index - 1}` : null, message: { role: "user", content: "Another question", timestamp: index * 2 + 1 } },
    { type: "message", id: `selection-assistant-${index}`, parentId: `selection-user-${index}`, message: { role: "assistant", content: "A long answer\n\n".repeat(8), stopReason: "stop", timestamp: index * 2 + 2 } },
  ]).flat();

  return { entries, leafId: "selection-assistant-19" };
};

const nextFrames = () => browser.execute(() => new Promise<null>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));

/** Scrolls the messages to a position. Repeated, because turns drawn near the view change the height. */
const scrollMessages = async (position: "bottom" | "middle") => {
  for (let jump = 0; jump < 3; jump++) {
    await browser.execute(where => {
      const messages = document.querySelector(".messages");

      if (!messages) throw new Error("Messages were not found");
      messages.scrollTop = where === "bottom" ? messages.scrollHeight : messages.scrollHeight / 2;

      return null;
    }, position);
    await nextFrames();
  }
};

/** Changes the selection and returns how far the turn at the center of the view moved, measured after the view handled the change and before the next frame is drawn. */
const centerTurnMovement = (change: "select" | "clear") => browser.execute(action => new Promise<number>((resolve, reject) => {
  const view = document.querySelector(".messages")?.getBoundingClientRect();
  const turn = view && document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2)?.closest(".deferred-turn");
  const selection = document.getSelection();

  if (!turn || !selection) { reject(new Error("No turn is at the center of the view")); return; }
  const top = turn.getBoundingClientRect().top;
  // Listeners run in order, so this one runs after the view's own listener.
  document.addEventListener("selectionchange", () => resolve(turn.getBoundingClientRect().top - top), { once: true });

  if (action === "clear") { selection.removeAllRanges(); return; }
  const range = document.createRange();
  range.selectNodeContents(turn);
  selection.addRange(range);
}), change);

describe("Chat selection", () => {
  beforeEach(async () => {
    await resetApp();
    await app.openConversations();
    await app.clearMessage();
    await startTemporaryConversation({ "pi_command:get_entries": longHistory() });
    await emitPiEvent({ type: "session_switched" });
    await expect($$(".deferred-turn")).toBeElementsArrayOfSize({ gte: 20 });
  });
  afterEach(async () => {
    await browser.execute(() => { document.getSelection()?.removeAllRanges(); return null; });
    await resetBackend();
  });

  it("keeps the content in place when text at the latest message is selected", async () => {
    await scrollMessages("bottom");
    const moved = await centerTurnMovement("select");

    await expect($(".chat-shell[data-text-selected]")).toBeExisting();
    expect(Math.abs(moved)).toBeLessThanOrEqual(1);
  });

  it("keeps the content in place when a selection in earlier history is removed", async () => {
    await scrollMessages("middle");
    await centerTurnMovement("select");
    await $(".chat-shell[data-text-selected]").waitForExist();
    await nextFrames();
    const moved = await centerTurnMovement("clear");

    await expect($(".chat-shell[data-text-selected]")).not.toBeExisting();
    expect(Math.abs(moved)).toBeLessThanOrEqual(1);
  });
});
