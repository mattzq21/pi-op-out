import { execFileSync } from "node:child_process";

function configuredSlots() {
  const value = process.env.PIOP_WINDOW_SLOTS;
  if (!value) return [];
  let slots;
  try { slots = JSON.parse(value); } catch (error) { throw new Error(`Invalid PIOP_WINDOW_SLOTS: ${error.message}`); }
  const valid = Array.isArray(slots) && slots.length > 0 && slots.every((slot) => slot && Number.isInteger(slot.x) && Number.isInteger(slot.y) && Number.isInteger(slot.width) && slot.width > 0 && Number.isInteger(slot.height) && slot.height > 0);
  if (!valid) throw new Error('Invalid PIOP_WINDOW_SLOTS: expected a non-empty JSON array of {"x","y","width","height"} integers');
  return slots.map(({ x, y, width, height }) => ({ x, y, width, height }));
}

export function selectWindowBounds() {
  const slots = configuredSlots();
  if (slots.length === 0) return undefined;
  let windows;
  try {
    windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    console.warn(`Could not list open windows with xwininfo (${error.message}); using the first PIOP_WINDOW_SLOTS slot`);
    return slots[0];
  }
  const siblingWindows = windows.split("\n")
    .filter((line) => /"piop(?: dev)?": \(/i.test(line))
    .map((line) => line.match(/(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)\s*$/))
    .filter(Boolean)
    .map((match) => ({ width: Number(match[1]), height: Number(match[2]), x: Number(match[3].replace(/^\+/, "")), y: Number(match[4].replace(/^\+/, "")) }));
  const occupied = ({ x, y, width, height }) => siblingWindows.some((window) => window.x < x + width && window.x + window.width > x && window.y < y + height && window.y + window.height > y);
  return slots.find((slot) => !occupied(slot)) ?? slots[0];
}
