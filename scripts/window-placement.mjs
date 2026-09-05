import { execFileSync } from "node:child_process";

export const topWindowBounds = Object.freeze({ x: 2560, y: 56, width: 1280, height: 692 });
export const bottomWindowBounds = Object.freeze({ x: 2560, y: 748, width: 1280, height: 692 });
export const tertiaryWindowBounds = Object.freeze({ x: 1285, y: 56, width: 1275, height: 692 });
export const quaternaryWindowBounds = Object.freeze({ x: 1285, y: 748, width: 1275, height: 692 });
const windowSlots = [topWindowBounds, bottomWindowBounds, tertiaryWindowBounds, quaternaryWindowBounds];

export function selectWindowBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const piWindows = windows.split("\n").filter((line) => /"piop": \("piop" "piop"\)/i.test(line));
    return windowSlots.find(({ x, y, width, height }) =>
      !piWindows.some((line) => line.includes(`${width}x${height}+${x}+${y}`))
    ) ?? quaternaryWindowBounds;
  } catch {
    return topWindowBounds;
  }
}
