import { execFileSync } from "node:child_process";

export const topWindowBounds = Object.freeze({ x: 2560, y: 56, width: 1280, height: 692 });

export const bottomWindowBounds = Object.freeze({ x: 2560, y: 748, width: 1280, height: 692 });

export const tertiaryWindowBounds = Object.freeze({ x: 3840, y: 56, width: 1280, height: 692 });

export const quaternaryWindowBounds = Object.freeze({ x: 3840, y: 748, width: 1280, height: 692 });

const windowSlots = [topWindowBounds, bottomWindowBounds, tertiaryWindowBounds, quaternaryWindowBounds];

export function selectWindowBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    const siblingWindows = windows.split("\n")
      .filter((line) => /"(?:piop|codop)(?: dev)?": \(/i.test(line))
      .map((line) => line.match(/(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)\s*$/))
      .filter(Boolean)
      .map((match) => ({ width: Number(match[1]), height: Number(match[2]), x: Number(match[3].replace(/^\+/, "")), y: Number(match[4].replace(/^\+/, "")) }));

    return windowSlots.find(({ x, y, width, height }) =>
      !siblingWindows.some((window) => window.x < x + width && window.x + window.width > x && window.y < y + height && window.y + window.height > y)
    ) ?? quaternaryWindowBounds;
  } catch {
    return topWindowBounds;
  }
}
