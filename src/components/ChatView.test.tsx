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
    expect(document.querySelector(".pi-avatar")).not.toBeInTheDocument();
    expect(screen.queryByText("Work · 2 steps")).not.toBeInTheDocument();
    expect(screen.getByText("inspect")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("Tool output")).not.toBeVisible();
    expect(screen.getByText("Intermediate update")).toBeVisible();

    view.rerender(<ChatView state={state(false)} messages={messages} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    const work = screen.getByText("Work · 2 steps").closest("details");
    expect(work).not.toHaveAttribute("open");
    expect(screen.getByText("Final answer")).toBeVisible();
    expect(screen.getByText("Tool output")).not.toBeVisible();
    expect(screen.getByText("Intermediate update")).not.toBeVisible();
  });

  it("groups consecutive completed calls to the same tool", () => {
    const repeated: ChatMessage[] = [
      { id: "user", role: "user", content: "Run checks" },
      { id: "call-1", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-call-1", name: "bash", arguments: {} }] },
      { id: "bash-1", role: "tool", toolName: "bash", toolStatus: "done", content: "first" },
      { id: "call-2", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-call-2", name: "bash", arguments: {} }] },
      { id: "bash-2", role: "tool", toolName: "bash", toolStatus: "done", content: "second" },
      { id: "call-3", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-call-3", name: "bash", arguments: {} }] },
      { id: "bash-3", role: "tool", toolName: "bash", toolStatus: "done", content: "third" },
      { id: "final", role: "assistant", content: "Done" }
    ];
    render(<ChatView state={{ ...state(false), messageCount: repeated.length }} messages={repeated} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    const work = screen.getByText("Work · 6 steps").closest("details")!;
    fireEvent.click(screen.getByText("Work · 6 steps"));
    expect(screen.getByText("bash x3")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(work.querySelectorAll(".tool-event")).toHaveLength(1);
    expect(work.querySelectorAll(".assistant-message")).toHaveLength(0);
    expect(screen.getByText(/first\s+second\s+third/)).not.toBeVisible();
  });

  it("copies an individual Markdown code block", async () => {
    const user = userEvent.setup();
    const codeMessage: ChatMessage[] = [{ id: "code", role: "assistant", content: "```ts\nconst answer = 42;\n```" }];
    render(<ChatView state={{ ...state(false), messageCount: 1 }} messages={codeMessage} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("const answer = 42;");
    expect(screen.getByRole("button", { name: "Code copied" })).toBeVisible();
  });

  it("keeps reasoning traces inside settled work and shows them while running", () => {
    const reasoned: ChatMessage[] = [
      { id: "user", role: "user", content: "Investigate" },
      { id: "tool-call", role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "I should inspect the relevant files." }, { type: "toolCall", id: "call", name: "read", arguments: {} }] },
      { id: "tool", role: "tool", toolName: "read", toolStatus: "done", content: "file contents" },
      { id: "answer", role: "assistant", content: [{ type: "thinking", thinking: "The evidence supports the fix." }, { type: "text", text: "Final result" }] }
    ];
    const view = render(<ChatView state={{ ...state(false), messageCount: reasoned.length }} messages={reasoned} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(screen.getByText("Final result")).toBeVisible();
    expect(screen.getByText("I should inspect the relevant files.")).not.toBeVisible();
    expect(screen.getByText("The evidence supports the fix.")).not.toBeVisible();
    fireEvent.click(screen.getByText("Work · 3 steps"));
    expect(screen.getByText("I should inspect the relevant files.")).toBeVisible();
    expect(screen.getByText("The evidence supports the fix.")).toBeVisible();

    view.rerender(<ChatView state={{ ...state(true), messageCount: reasoned.length }} messages={reasoned} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(screen.getByText("I should inspect the relevant files.")).toBeVisible();
    expect(screen.getByText("The evidence supports the fix.")).toBeVisible();
  });
});
