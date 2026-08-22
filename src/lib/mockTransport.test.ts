import { describe, expect, it, vi } from "vitest";
import { MockTransport } from "./mockTransport";

describe("MockTransport", () => {
  it("streams a prompt and persists it in the session tree", async () => {
    const transport = new MockTransport(); const events: string[] = [];
    transport.subscribe((event) => events.push(event.type));
    await transport.command({ type: "prompt", message: "Test the transport" });
    const data = await transport.command<{ entries: Array<{ message: { content: unknown } }> }>({ type: "get_entries" });
    expect(data.entries).toHaveLength(6);
    expect(events).toContain("message_update");
    expect(events.at(-1)).toBe("agent_end");
  });

  it("forks at a durable entry and changes session identity", async () => {
    const transport = new MockTransport();
    await transport.command({ type: "fork", entryId: "entry-u2" });
    const state = await transport.command<{ sessionId: string; sessionName: string }>({ type: "get_state" });
    const data = await transport.command<{ entries: unknown[] }>({ type: "get_entries" });
    expect(state.sessionId).toMatch(/^branch-/);
    expect(state.sessionName).toContain("branch");
    expect(data.entries).toHaveLength(3);
  });

  it("emits an abort event", async () => {
    const transport = new MockTransport(); const listener = vi.fn(); transport.subscribe(listener);
    await transport.command({ type: "abort" });
    expect(listener).toHaveBeenCalledWith({ type: "agent_end" });
  });
});
