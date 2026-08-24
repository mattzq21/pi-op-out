import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../defaults";
import { SettingsView } from "./SettingsView";

describe("skill invocation settings", () => {
  it("keeps user-invoked-only skills fixed and excludes them from bulk toggles", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={{
      ...structuredClone(defaultSettings),
      skills: [
        { name: "Explicit skill", path: "/skills/explicit", description: "Explicit only", enabled: true, scope: "global", userInvokedOnly: true },
        { name: "Regular skill", path: "/skills/regular", description: "May be invoked implicitly", enabled: true, scope: "global" }
      ]
    }} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByText("User invoked only")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Enable Explicit skill" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable Regular skill" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Remove .* skill/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disable all" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      skills: [
        expect.objectContaining({ name: "Explicit skill", enabled: true, userInvokedOnly: true }),
        expect.objectContaining({ name: "Regular skill", enabled: false })
      ]
    }));
  });
});

describe("machine settings", () => {
  it("saves an SSH machine while keeping Local implicit", async () => {
    const user = userEvent.setup(); const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={structuredClone(defaultSettings)} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Machines" }));
    expect(screen.getByText("This machine")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add machine" }));
    await user.clear(screen.getByLabelText("Machine name")); await user.type(screen.getByLabelText("Machine name"), "Build VPS");
    await user.type(screen.getByLabelText("Build VPS SSH target"), "deploy@example.com");
    await user.clear(screen.getByLabelText("Build VPS Pi executable")); await user.type(screen.getByLabelText("Build VPS Pi executable"), "/home/deploy/.local/bin/pi");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ hosts: [expect.objectContaining({ name: "Build VPS", target: "deploy@example.com", piPath: "/home/deploy/.local/bin/pi" })] }));
  });
});

describe("session broker tools", () => {
  it("lets the user disable agent messaging", async () => {
    const user = userEvent.setup(); const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={structuredClone(defaultSettings)} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("list_agents")).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "Enable send_message" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "send_message", enabled: false })]) }));
  });
});
