import { execFileSync } from "node:child_process";

export const topWindowBounds = Object.freeze({ x: 2560, y: 56, width: 1280, height: 692 });
export const bottomWindowBounds = Object.freeze({ x: 2560, y: 748, width: 1280, height: 692 });

export function serializeWindowBounds({ x, y, width, height }) {
  return `${x},${y},${width},${height}`;
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
