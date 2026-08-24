import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
