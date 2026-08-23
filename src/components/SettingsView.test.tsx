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
