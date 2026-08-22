import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    render(<ChatView state={{ ...state(false), sessionName: title }} messages={[]} models={[]} commands={[]} thinkingLevels={["off"]} widgets={[]} statuses={[]} {...callbacks} />);
    expect(screen.getByText("12345678901234567890123456789012345678901234567890…")).toHaveAttribute("title", title);
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(document.querySelector(".status-dot")).not.toBeInTheDocument();
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
