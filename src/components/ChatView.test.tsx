import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentState, ChatMessage } from "../types";
import { ChatView } from "./ChatView";

const messages: ChatMessage[] = [
  { id: "user", role: "user", content: "Please inspect this." },
  { id: "tool", role: "tool", toolName: "inspect", toolStatus: "done", content: "Tool output" },
  { id: "progress", role: "assistant", content: "Intermediate update" },
  { id: "final", role: "assistant", content: "Final answer" }
];

const state = (isStreaming: boolean): AgentState => ({ model: null, thinkingLevel: "off", isStreaming, sessionId: "test", messageCount: messages.length, pendingMessageCount: 0 });
const callbacks = { onSend: () => undefined, onAbort: () => undefined, onOpenTerminal: () => undefined, onBranch: () => undefined, onModel: () => undefined, onThinking: () => undefined };

describe("conversation work visibility", () => {
  it("limits long chat-header titles to 50 characters", () => {
    const title = "123456789012345678901234567890123456789012345678901 and more";
    render(<ChatView state={{ ...state(false), sessionName: title }} messages={messages} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(screen.getByText("12345678901234567890123456789012345678901234567890…")).toHaveAttribute("title", title);
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(document.querySelector(".status-dot")).not.toBeInTheDocument();
  });

  it("hides the chat header for a new empty session", () => {
    render(<ChatView state={{ ...state(false), sessionName: "Untitled session" }} messages={[]} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(document.querySelector(".chat-header")).not.toBeInTheDocument();
  });

  it("grows the composer with multiline content and caps its height", () => {
    render(<ChatView state={state(false)} messages={messages} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 86 });
    fireEvent.change(composer, { target: { value: "one\ntwo\nthree" } });
    expect(composer).toHaveStyle({ height: "86px", overflowY: "hidden" });
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 180 });
    fireEvent.change(composer, { target: { value: "one\ntwo\nthree\nfour" } });
    expect(composer).toHaveStyle({ height: "130px", overflowY: "auto" });
  });

  it("shows an ultimately aborted response as a failure with a retry for its prompt", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const aborted: ChatMessage[] = [
      { id: "request", role: "user", content: "x scrolling" },
      { id: "aborted", role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }
    ];
    const view = render(<ChatView state={{ ...state(false), messageCount: aborted.length }} messages={aborted} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} onSend={onSend} />);
    expect(screen.getByText("Operation aborted")).toBeVisible();
    expect(screen.queryByText(/Work ·/)).not.toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    expect(composer).toHaveValue("x scrolling");
    await user.clear(composer); await user.type(composer, "use vertical tabs{enter}");
    expect(onSend).toHaveBeenLastCalledWith("use vertical tabs", undefined, []);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onSend).toHaveBeenLastCalledWith("x scrolling");
    expect(composer).toHaveValue("");
    const continued = [...aborted, { id: "later-user", role: "user", content: "huh?" }, { id: "later-answer", role: "assistant", content: "Here is the answer." }] as ChatMessage[];
    view.rerender(<ChatView state={{ ...state(false), messageCount: continued.length }} messages={continued} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} onSend={onSend} />);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows all work while running and collapses it when the turn settles", () => {
    const view = render(<ChatView state={state(true)} messages={messages} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(screen.queryByText("Work · 2 steps")).not.toBeInTheDocument();
    expect(screen.getByText("Tool output")).toBeVisible();
    expect(screen.getByText("Intermediate update")).toBeVisible();

    view.rerender(<ChatView state={state(false)} messages={messages} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    const work = screen.getByText("Work · 2 steps").closest("details");
    expect(work).not.toHaveAttribute("open");
    expect(screen.getByText("Final answer")).toBeVisible();
    expect(screen.getByText("Tool output")).not.toBeVisible();
    expect(screen.getByText("Intermediate update")).not.toBeVisible();
  });
});
