import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RpcCommand, RpcEvent } from "./types";

vi.mock("./lib/transport", async () => {
  const { MockTransport } = await import("./lib/mockTransport");
  class StaleExtensionTransport extends MockTransport {
    private listener?: (event: RpcEvent) => void;
    override subscribe(listener: (event: RpcEvent) => void) { this.listener = listener; return super.subscribe(listener); }
    override async command<T>(command: RpcCommand): Promise<T> {
      const result = await super.command<T>(command);
      if (command.type === "switch_session") this.listener?.({ type: "extension_error", error: "This extension ctx is stale after session replacement or reload. Do not use a captured ctx." });
      return result;
    }
  }
  return { createTransport: () => new StaleExtensionTransport() };
});

import App from "./App";

it("does not show stale extension errors from the session being replaced", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Wire RPC transport/ }));
  await waitFor(() => expect(screen.getByText(/browser preview for/)).toHaveTextContent("Wire RPC transport"));
  expect(screen.queryByText("Extension error")).not.toBeInTheDocument();
});
