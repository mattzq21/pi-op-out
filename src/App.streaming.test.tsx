import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RpcEvent } from "./types";

const control = vi.hoisted(() => ({
  listener: undefined as ((event: RpcEvent) => void) | undefined,
  entryCalls: 0,
  resolveStale: undefined as ((value: { entries: []; leafId: null }) => void) | undefined
}));

vi.mock("./lib/transport", async () => {
  const { defaultSettings } = await import("./defaults");
  const state = { model: null, thinkingLevel: "off", isStreaming: true, sessionId: "test", sessionName: "Test", messageCount: 0, pendingMessageCount: 0 };
  return { createTransport: () => ({
    mode: "browser" as const,
    connect: async () => undefined,
    disconnect: async () => undefined,
    subscribe: (listener: (event: RpcEvent) => void) => { control.listener = listener; return () => undefined; },
    command: async (command: { type: string }) => {
      if (command.type === "get_state") return state;
      if (command.type === "get_entries") {
        control.entryCalls += 1;
        if (control.entryCalls === 1) return { entries: [], leafId: null };
        return new Promise((resolve) => { control.resolveStale = resolve as typeof control.resolveStale; });
      }
      if (command.type === "get_available_models") return { models: [] };
      if (command.type === "get_available_thinking_levels") return { levels: ["off"] };
      if (command.type === "get_commands") return { commands: [] };
      return {};
    },
    listSessions: async () => [],
    archiveSession: async () => undefined,
    relocateSession: async () => undefined,
    loadSettings: async () => structuredClone(defaultSettings),
    loadCodexUsage: async () => ({ remainingPercent: 50 }),
    saveSettings: async () => undefined,
    selectProjectDirectory: async () => null,
    openProject: async () => undefined,
    startTerminal: async () => undefined,
    writeTerminal: async () => undefined,
    resizeTerminal: async () => undefined,
    closeTerminal: async () => undefined
  }) };
});

import App from "./App";

beforeEach(() => {
  control.listener = undefined;
  control.entryCalls = 0;
  control.resolveStale = undefined;
});

it("does not let an older snapshot erase newer live work", async () => {
  render(<App />);
  await screen.findByRole("textbox", { name: "Message Pi" });
  act(() => {
    control.listener?.({ type: "agent_start" });
    control.listener?.({ type: "message_end", message: { id: "thought-1", role: "assistant", content: [{ type: "thinking", thinking: "first thought" }] } });
  });
  await waitFor(() => expect(control.entryCalls).toBe(2));

  act(() => {
    control.listener?.({ type: "message_update", message: { id: "thought-2", role: "assistant", content: [{ type: "thinking", thinking: "second thought" }] } });
    control.listener?.({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "pwd" } });
  });
  expect(screen.getByText("second thought")).toBeVisible();
  expect(screen.getByText("bash")).toBeVisible();

  await act(async () => control.resolveStale?.({ entries: [], leafId: null }));
  expect(screen.getByText("second thought")).toBeVisible();
  expect(screen.getByText("bash")).toBeVisible();
});

it("renders Pi assistant deltas before message_end", async () => {
  render(<App />);
  await screen.findByRole("textbox", { name: "Message Pi" });
  act(() => {
    control.listener?.({ type: "agent_start" });
    control.listener?.({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
    control.listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    control.listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking now" } });
    control.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
    control.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Still working" } });
  });
  expect(screen.getByText("Checking now")).toBeVisible();
  expect(screen.getByText("Still working")).toBeVisible();
});
