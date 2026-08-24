import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("./lib/transport", async () => {
  const { MockTransport } = await import("./lib/mockTransport");
  class SlowSessionIndexTransport extends MockTransport {
    private sessionRequests = 0;

    override async listSessions() {
      const sessions = await super.listSessions();
      if (this.sessionRequests++ === 0) return sessions;
      return new Promise<typeof sessions>(() => undefined);
    }
  }
  return { createTransport: () => new SlowSessionIndexTransport() };
});

import App from "./App";

it("loads conversation content without waiting for a slow cross-machine session index", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Wire RPC transport/ }));
  expect(await screen.findByText(/browser preview for/, {}, { timeout: 250 })).toHaveTextContent("Wire RPC transport");
});
