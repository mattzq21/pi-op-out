import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";
import { SessionPanel } from "./SessionPanel";

const sessions: SessionSummary[] = [
  { id: "active", name: "Active chat", project: "Project one", preview: "Current", path: "/sessions/active", cwd: "/projects/one", updatedAt: new Date().toISOString(), messageCount: 1 },
  { id: "other", name: "Other chat", project: "Project two", preview: "Other", path: "/sessions/other", cwd: "/projects/two", updatedAt: new Date().toISOString(), messageCount: 1 }
];

describe("SessionPanel", () => {
  it("marks the active session's project label", () => {
    render(<SessionPanel sessions={sessions} activeId="active" query="" onQuery={() => undefined} onSelect={() => undefined} onAction={() => undefined} />);
    expect(screen.getByText("Project one")).toHaveClass("active");
    expect(screen.getByText("Project two")).not.toHaveClass("active");
  });

  it("separates projects and active sessions by machine", () => {
    const remote = { ...sessions[0], hostId: "vps", hostName: "Build VPS", id: "active" };
    render(<SessionPanel sessions={[sessions[0], remote]} activeId="active" activeHostId="vps" query="" onQuery={() => undefined} onSelect={() => undefined} onAction={() => undefined} />);
    expect(screen.getByText("Build VPS / Project one")).toHaveClass("active");
    expect(screen.getByText("Project one")).not.toHaveClass("active");
  });

  it("offers split pane only for a session that is not currently open", async () => {
    const user = userEvent.setup(); const onAction = vi.fn();
    render(<SessionPanel sessions={sessions} activeId="active" query="" onQuery={() => undefined} onSelect={() => undefined} onAction={onAction} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Active chat/ }));
    expect(screen.queryByRole("menuitem", { name: "Split pane" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByRole("button", { name: /Other chat/ }));
    await user.click(screen.getByRole("menuitem", { name: "Split pane" }));
    expect(onAction).toHaveBeenCalledWith(sessions[1], "split");
  });
});
