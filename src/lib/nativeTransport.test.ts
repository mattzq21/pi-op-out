import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeTransport } from "./nativeTransport";

const eventMock = vi.hoisted(() => ({
  subscriptions: [] as { callback: (event: { payload: unknown }) => void; active: boolean; resolve: (unlisten: () => void) => void }[]
}));
const invokeMock = vi.hoisted(() => vi.fn(async (command: string) => command === "create_temporary_chat" ? { cwd: "/home/matt/pi-desktop/tmp/chat-id", sessionId: "chat-id" } : undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, callback: (event: { payload: unknown }) => void) => new Promise<() => void>((resolve) => {
    eventMock.subscriptions.push({ callback, active: true, resolve });
  }))
}));

describe("NativeTransport event lifecycle", () => {
  beforeEach(() => { eventMock.subscriptions.length = 0; invokeMock.mockClear(); });

  it("starts an unassigned chat in its own temporary directory", async () => {
    const transport = new NativeTransport();
    const connected = transport.connect();
    await vi.waitFor(() => expect(eventMock.subscriptions).toHaveLength(1));
    eventMock.subscriptions[0].resolve(() => undefined); await connected;
    expect(invokeMock).toHaveBeenCalledWith("create_temporary_chat", { hostId: "local" });
    expect(invokeMock).toHaveBeenCalledWith("start_pi", { runtimeId: expect.any(String), cwd: "/home/matt/pi-desktop/tmp/chat-id", sessionPath: undefined, sessionId: "chat-id", hostId: "local" });
  });

  it("does not double-deliver terminal output when an interrupted connection finishes late", async () => {
    const transport = new NativeTransport(); const listener = vi.fn(); transport.subscribe(listener);
    const firstConnect = transport.connect();
    await vi.waitFor(() => expect(eventMock.subscriptions).toHaveLength(1));
    await transport.disconnect();
    const first = eventMock.subscriptions[0]; first.resolve(() => { first.active = false; }); await firstConnect;

    const secondConnect = transport.connect();
    await vi.waitFor(() => expect(eventMock.subscriptions).toHaveLength(2));
    const second = eventMock.subscriptions[1]; second.resolve(() => { second.active = false; }); await secondConnect;

    for (const subscription of eventMock.subscriptions) if (subscription.active) subscription.callback({ payload: { type: "terminal_output", terminalId: "terminal-1", data: "x" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps simultaneous Pi process events in their owning chat shell", async () => {
    const first = new NativeTransport(); const second = new NativeTransport(); const firstListener = vi.fn(); const secondListener = vi.fn(); first.subscribe(firstListener); second.subscribe(secondListener);
    const connections = [first.connect("/one", "one.jsonl"), second.connect("/two", "two.jsonl")];
    await vi.waitFor(() => expect(eventMock.subscriptions).toHaveLength(2));
    eventMock.subscriptions.forEach((subscription) => subscription.resolve(() => { subscription.active = false; })); await Promise.all(connections);
    const runtimeIds = (invokeMock.mock.calls as unknown as Array<[string, { runtimeId: string }]>).filter(([command]) => command === "start_pi").map(([, args]) => args.runtimeId);
    for (const subscription of eventMock.subscriptions) subscription.callback({ payload: { runtimeId: runtimeIds[0], event: { type: "agent_start" } } });
    expect(firstListener).toHaveBeenCalledWith({ type: "agent_start" }); expect(secondListener).not.toHaveBeenCalled();
    for (const subscription of eventMock.subscriptions) subscription.callback({ payload: { runtimeId: runtimeIds[1], event: { type: "agent_end" } } });
    expect(secondListener).toHaveBeenCalledWith({ type: "agent_end" }); expect(firstListener).toHaveBeenCalledTimes(1);
  });
});
