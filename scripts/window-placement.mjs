import { execFileSync } from "node:child_process";

const topRightWindowBounds = Object.freeze({ x: 1280, y: 56, width: 1280, height: 692 });

const bottomRightWindowBounds = Object.freeze({ x: 1280, y: 748, width: 1280, height: 692 });

const topLeftWindowBounds = Object.freeze({ x: 0, y: 56, width: 1280, height: 692 });

const windowSlots = [topRightWindowBounds, bottomRightWindowBounds, topLeftWindowBounds];

export function selectWindowBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    const siblingWindows = windows.split("\n")
      .filter((line) => /"piop(?: dev)?": \(/i.test(line))
      .map((line) => line.match(/(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)\s*$/))
      .filter(Boolean)
      .map((match) => ({ width: Number(match[1]), height: Number(match[2]), x: Number(match[3].replace(/^\+/, "")), y: Number(match[4].replace(/^\+/, "")) }));

    const occupied = ({ x, y, width, height }) => siblingWindows.some((window) => window.x < x + width && window.x + window.width > x && window.y < y + height && window.y + window.height > y);

    return windowSlots.find((slot) => !occupied(slot)) ?? topRightWindowBounds;
  } catch {
    return topRightWindowBounds;
  }
}
