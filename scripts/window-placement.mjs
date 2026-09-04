import { execFileSync } from "node:child_process";

export const topWindowBounds = Object.freeze({ x: 2560, y: 56, width: 1280, height: 692 });
export const bottomWindowBounds = Object.freeze({ x: 2560, y: 748, width: 1280, height: 692 });

export function toX11CreationBounds(bounds) {
  // GTK adds 37px while initially mapping the window on this GNOME/XWayland layout,
  // including undecorated windows. Keep this conversion identical for dev and E2E.
  return { ...bounds, height: bounds.height - 37 };
}

export function selectWindowBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const geometry = `${topWindowBounds.width}x${topWindowBounds.height}+${topWindowBounds.x}+${topWindowBounds.y}`;
    const topSlotOccupied = windows.split("\n").some((line) =>
      line.includes('"Pi": ("pi-desktop" "Pi-desktop")') && line.includes(geometry)
    );
    return topSlotOccupied ? bottomWindowBounds : topWindowBounds;
  } catch {
    return topWindowBounds;
  }
}
