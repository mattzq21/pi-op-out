import { execFileSync } from "node:child_process";

export const topWindowBounds = Object.freeze({ x: 2560, y: 56, width: 1280, height: 692 });
export const bottomWindowBounds = Object.freeze({ x: 2560, y: 748, width: 1280, height: 692 });
export const tertiaryWindowBounds = Object.freeze({ x: 1285, y: 56, width: 1275, height: 692 });
const windowSlots = [topWindowBounds, bottomWindowBounds, tertiaryWindowBounds];

export function toX11CreationBounds(bounds) {
  // GTK adds 37px while initially mapping the window on this GNOME/XWayland layout,
  // including undecorated windows. Keep this conversion identical for dev and E2E.
  return { ...bounds, height: bounds.height - 37 };
}

export function selectWindowBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const piWindows = windows.split("\n").filter((line) => line.includes('"Pi": ("pi-desktop" "Pi-desktop")'));
    return windowSlots.find(({ x, y, width, height }) =>
      !piWindows.some((line) => line.includes(`${width}x${height}+${x}+${y}`))
    ) ?? tertiaryWindowBounds;
  } catch {
    return topWindowBounds;
  }
}
