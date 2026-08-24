import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RpcCommand } from "./types";

const lifecycle = vi.hoisted(() => ({ connects: 0, disconnects: 0 }));

vi.mock("./lib/transport", async () => {
  const { MockTransport } = await import("./lib/mockTransport");
  class VpsSwitchTransport extends MockTransport {
    override async connect(_cwd?: string, sessionPath?: string) { lifecycle.connects += 1; await super.connect(); if (sessionPath) await super.command({ type: "switch_session", sessionPath }); }
    override async disconnect() { lifecycle.disconnects += 1; await super.disconnect(); }
    override async listSessions() {
      return (await super.listSessions()).map((session) => session.id === "rpc" ? { ...session, hostId: "vps", hostName: "VPS" } : session);
    }
    override async command<T>(command: RpcCommand): Promise<T> {
      if (command.type === "get_state" && lifecycle.disconnects > 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (lifecycle.disconnects > 1) throw new Error("Pi disconnected before responding");
      }
      return super.command<T>(command);
    }
  }
  return { createTransport: () => new VpsSwitchTransport() };
});

import App from "./App";

it("does not report an intentional VPS session handoff as a connection failure", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Wire RPC transport/ }));
  await waitFor(() => expect(screen.getByText(/browser preview for/)).toHaveTextContent("Wire RPC transport"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(screen.queryByText("Pi could not connect")).not.toBeInTheDocument();
  expect(lifecycle.disconnects).toBe(1);
  expect(lifecycle.connects).toBe(2);
});
