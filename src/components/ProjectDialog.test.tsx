import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProjectDialog } from "./ProjectDialog";

it("browses and opens a project on an SSH machine", async () => {
  const user = userEvent.setup(); const onChooseDirectory = vi.fn()
    .mockResolvedValueOnce({ path: "/srv", parent: "/", directories: ["/srv/app"] })
    .mockResolvedValueOnce({ path: "/srv/app", parent: "/srv", directories: [] });
  const onOpen = vi.fn();
  render(<ProjectDialog initialPath="" initialHostId="local" hosts={[{ id: "vps", name: "Build VPS", target: "deploy@example.com", piPath: "pi" }]} onChooseDirectory={onChooseDirectory} onOpen={onOpen} onCancel={() => undefined} />);
  await user.selectOptions(screen.getByLabelText("Machine"), "vps");
  await user.click(screen.getByRole("button", { name: "Choose directory…" }));
  await user.click(screen.getByRole("button", { name: "app" }));
  expect(screen.getByLabelText("Project directory")).toHaveValue("/srv/app");
  await user.click(screen.getByRole("button", { name: "Open project" }));
  expect(onOpen).toHaveBeenCalledWith("/srv/app", "vps");
});
