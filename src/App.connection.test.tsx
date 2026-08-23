import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "./types";

vi.mock("./lib/transport", async () => {
  const { MockTransport } = await import("./lib/mockTransport");
  class StrictModeTransport extends MockTransport {
    private stateRequests = 0;
    override async command<T>(command: RpcCommand): Promise<T> {
      if (command.type === "get_state" && this.stateRequests++ === 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("Pi is not running");
      }
      return super.command<T>(command);
    }
  }
  return { createTransport: () => new StrictModeTransport() };
});

import App from "./App";

describe("Pi connection lifecycle", () => {
  it("does not show an abandoned Strict Mode startup error after the replacement connection succeeds", async () => {
    render(<StrictMode><App /></StrictMode>);
    expect((await screen.findAllByText("Design desktop shell")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText("Pi could not connect")).not.toBeInTheDocument(), { timeout: 100 });
  });
});
