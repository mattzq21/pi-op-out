import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeTransport } from "./nativeTransport";

const eventMock = vi.hoisted(() => ({
  subscriptions: [] as { callback: (event: { payload: unknown }) => void; active: boolean; resolve: (unlisten: () => void) => void }[]
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, callback: (event: { payload: unknown }) => void) => new Promise<() => void>((resolve) => {
    eventMock.subscriptions.push({ callback, active: true, resolve });
  }))
}));

describe("NativeTransport event lifecycle", () => {
  beforeEach(() => { eventMock.subscriptions.length = 0; });

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
});
